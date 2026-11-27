/**
 * 孤儿文件盘点与清理（`orbis prune-orphans`）。
 *
 * 「孤儿」= 文件还在磁盘上，但 `state.json` 已经不认它了：
 *   · `rooms/<id>.json` —— 房间被删过（老版本只删索引不删文件，或删一半失败），
 *     这批文件永远不会出现在界面上，也永远删不掉（界面只管 state.rooms）。
 *   · `sessions/<文件>.jsonl` —— 会话记录没有了对应的 `state.sessions` 引用。
 *
 * 为什么不在启动时偷偷删：删数据不可逆。启动只做**收尾**（把卡在 streaming 的消息
 * 改成「已中断」，见 store.js 的 #reapOrphanRoomFiles），不动文件本身。
 * 清理必须由用户显式触发，而且**默认只列出来**。
 *
 * 三条硬约束：
 *   1. `--apply` 之前一律只读（连目录都不建）；
 *   2. `--apply` 不是 unlink，是**挪到备份目录**（同盘 rename，可逆、不额外占空间）；
 *   3. 有引用的一律不碰 —— 判据只有一个：`state.json` 里有没有它。
 *
 * 这个模块是纯逻辑（不打印、不退出进程），CLI 外壳在 prune-orphans-cli.js。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 备份目录名前缀（放在数据目录里，用户自己确认后再删） */
export const BACKUP_PREFIX = 'orphans-backup-';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(dir, ext) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 会话文件的判据：`state.sessions` 的值是**绝对路径**，按文件名比对。
 *
 * 为什么只比文件名，不比完整路径：数据目录改过名 / 迁移过的机器上，
 * state 里存的是旧绝对路径（`repairSessionRefs` 会修，但修之前也是合法状态），
 * 按全路径比会把活会话误判成孤儿 —— 那才是最坏的结果。
 */
function sessionKeyOf(file) {
  // ★ state.json 里存的是**写入时那台机器**的绝对路径：Windows 写的反斜杠路径
  //   在 Linux/macOS 上 `path.basename` 切不开（POSIX 只认 `/`），
  //   于是活会话被当成孤儿挪走。先把反斜杠归一成 `/` 再取最后一段。
  const normalized = String(file ?? '').split(String.fromCharCode(92)).join('/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * 盘点，不写任何东西。
 *
 * @param {{dataDir:string, olderThanMs?:number, now?:number}} p
 * @returns {{dataDir:string, rooms:{files:Array<{file:string,size:number,roomId:string}>, bytes:number},
 *           sessions:{files:Array<{file:string,size:number}>, bytes:number},
 *           referenced:{rooms:number, sessions:number},
 *           backupDir:string|null}}
 */
export function findOrphans({ dataDir, olderThanMs = 0, now = Date.now() } = {}) {
  const roomsDir = path.join(dataDir, 'rooms');
  const sessionsDir = path.join(dataDir, 'sessions');
  // ★ 安全阀：state.json 是「谁是活的」的唯一判据。
  //   它损坏（非法 JSON）/ 缺 rooms / rooms 是数组时，`readJson` 会静默退化成 `{}` ——
  //   那样**所有活着**的房间与会话都会被当成孤儿挪走。宁可拒绝执行，也不能猜。
  const parsed = readJson(path.join(dataDir, 'state.json'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !parsed.rooms || typeof parsed.rooms !== 'object' || Array.isArray(parsed.rooms)) {
    throw new Error('state.json 无法解析或格式异常，拒绝判定孤儿文件');
  }
  const state = parsed;
  const liveRooms = Object.keys(state.rooms);
  const liveSessions = new Set(
    Object.values(state.sessions ?? {}).map((v) => sessionKeyOf(v)).filter(Boolean),
  );

  const recent = (file) => {
    if (!olderThanMs) return true;
    try {
      return now - fs.statSync(file).mtimeMs >= olderThanMs;
    } catch {
      return false;
    }
  };

  const roomFiles = [];
  for (const file of listFiles(roomsDir, '.json')) {
    const roomId = path.basename(file, '.json');
    if (state.rooms?.[roomId]) continue;
    if (!recent(file)) continue;
    roomFiles.push({ file, roomId, size: statSize(file) });
  }

  const sessionFiles = [];
  for (const file of listFiles(sessionsDir, '.jsonl')) {
    if (liveSessions.has(sessionKeyOf(file))) continue;
    if (!recent(file)) continue;
    sessionFiles.push({ file, size: statSize(file) });
  }

  const sum = (arr) => arr.reduce((n, x) => n + x.size, 0);
  return {
    dataDir,
    rooms: { files: roomFiles, bytes: sum(roomFiles) },
    sessions: { files: sessionFiles, bytes: sum(sessionFiles) },
    referenced: { rooms: liveRooms.length, sessions: liveSessions.size },
    backupDir: null,
  };
}

/**
 * 执行清理：把孤儿文件**挪进** `data/orphans-backup-<时间戳>/`。
 *
 * 不用 unlink 的原因：房间文件里有用户真实聊天记录。判断错了就是永久丢失，
 * 而 rename 到备份目录是同一分区内的原子操作，用户随时能挪回来。
 *
 * @param {{dataDir:string, olderThanMs?:number, now?:number, apply?:boolean, stamp?:string,
 *          mkdir?:typeof fs.mkdirSync, rename?:typeof fs.renameSync}} p
 */
export function pruneOrphans({
  dataDir,
  olderThanMs = 0,
  now = Date.now(),
  apply = false,
  stamp = null,
  mkdir = fs.mkdirSync,
  rename = fs.renameSync,
} = {}) {
  const report = findOrphans({ dataDir, olderThanMs, now });
  if (!apply) return { ...report, applied: false, moved: 0 };
  if (!report.rooms.files.length && !report.sessions.files.length) {
    return { ...report, applied: true, moved: 0 };
  }

  const ts = stamp ?? new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, `${BACKUP_PREFIX}${ts}`);
  mkdir(path.join(backupDir, 'rooms'), { recursive: true });
  mkdir(path.join(backupDir, 'sessions'), { recursive: true });

  let moved = 0;
  for (const item of report.rooms.files) {
    rename(item.file, path.join(backupDir, 'rooms', path.basename(item.file)));
    moved += 1;
  }
  for (const item of report.sessions.files) {
    rename(item.file, path.join(backupDir, 'sessions', path.basename(item.file)));
    moved += 1;
  }

  return { ...report, applied: true, moved, backupDir };
}
