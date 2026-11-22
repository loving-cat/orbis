/**
 * `orbis migrate`：把数据从旧品牌目录**复制**到新目录（只复制，绝不动旧目录）。
 *
 * 为什么需要这个命令：1.7 里 `resolveHomeDir()` 还在做"新目录不存在就沿用旧目录"，
 * 到 2.0 那段回退一删，老用户启动就会看到一个**空的家** —— 聊天记录、任务、
 * 证书（手机固定的指纹）全"没了"。所以先给一个显式的迁移步骤：
 *   停服务 → `orbis migrate` → 看到报告 → 再启动。
 *
 * 四条硬约束（都是踩过坑才写下的）：
 *
 *   1. **只复制，不删除**：旧目录原样保留，用户自己确认没问题后再手动删。
 *      迁移过程中任何一步失败，旧目录都是完整的 —— 这是唯一能让人放心的姿态。
 *   2. **幂等**：`migration-report.json` 存在 = 已经迁移过，第二次直接返回 `already`。
 *      用户手滑跑两遍不该出现"第二遍把第一遍的数据覆盖了"。
 *   3. **目标已有数据就拒绝**（除非 `--force`）：新目录里可能是用户已经跑过一段时间
 *      的**真数据**，覆盖它等于删库。`--force` 的语义也只是"补齐缺失的文件"，
 *      永远不覆盖已存在的文件。
 *   4. **报告落盘**：`migration-report.json` 写清从哪来、搬了什么、跳过了什么、
 *      工作目录是哪个 —— 支持用户来问"我的东西呢"时有据可查。
 *
 * 边界：不迁移 `workspace`（里面常有几百 MB 的 .venv / node_modules，且虚拟环境里
 * 的绝对路径复制过去就坏了）；只在报告里记下旧工作目录，让服务端继续用它
 * （`config.js` 的 `migratedWorkspace()` 读的就是同一个标记文件）。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ENTRIES, MIGRATION_MARKER, NEEDS_MIGRATION_MARKER, isInside, repairSessionRefs,
} from './data-migration.js';

/** 迁移报告的文件名（放在**新**目录里） */
export const MIGRATION_REPORT = 'migration-report.json';

/** 跟着组件名一起改名的配置文件（都在数据目录里，有就复制） */
export const CONFIG_RENAMES = Object.freeze([
  { from: 'pi-bot.config.json', to: 'orbis.config.json' },
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** 目录里有没有"值得迁移的东西"（只看 ENTRIES 与要改名的配置） */
export function hasLegacyData(dir) {
  if (!dir) return false;
  for (const name of [...ENTRIES, ...CONFIG_RENAMES.map((r) => r.from)]) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

/**
 * 复制一个条目（目录或文件），**永不覆盖已存在的文件**。
 *
 * ★ 目录必须**递归合并**，不能"目标目录已存在就整棵跳过"：
 *   用户可能先不小心起过一次 2.0（于是目标里已经有空的 `rooms/` / `sessions/` /
 *   `uploads/`），这时整棵跳过等于**聊天记录一条都不搬**，而 `--force` 也救不回来。
 *
 * @returns {'copied'|'merged'|'kept'|'missing'}
 *   copied = 目标原本没有，整棵复制；merged = 目标已有目录，补了缺的文件；
 *   kept = 目标已有同名文件（不覆盖）；missing = 来源没有。
 */
function copyEntry(from, to, { dryRun = false } = {}) {
  if (!fs.existsSync(from)) return 'missing';

  const srcStat = fs.statSync(from);
  const dstExists = fs.existsSync(to);

  if (!srcStat.isDirectory()) {
    // 文件：目标已有就保留（永不覆盖）
    if (dstExists) return 'kept';
    if (dryRun) return 'copied';
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const st = fs.statSync(from);
    fs.utimesSync(to, st.atime, st.mtime);
    return 'copied';
  }

  // 目录
  const dstIsDir = dstExists && fs.statSync(to).isDirectory();
  if (dstExists && !dstIsDir) return 'kept'; // 同名文件挡着，别硬写
  // ★ dry-run 也要**真的往下走**：只在要不要 mkdir 上分支，
  //   否则干跑会把“目标里已经有全套文件”说成 merged，让人以为迁完会有东西变。
  if (!dryRun && !dstIsDir) fs.mkdirSync(to, { recursive: true });

  let wrote = false;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // 上传分片的半成品（`_` 开头）不复制：它们只对当时那个进程有意义
    if (entry.name.startsWith('_')) continue;
    const r = copyEntry(path.join(from, entry.name), path.join(to, entry.name), { dryRun });
    if (r === 'copied' || r === 'merged') wrote = true;
  }
  // dstIsDir + 真的补了东西 = merged；目标原本就有、啥也没写 = kept
  return dstIsDir && wrote ? 'merged' : (dstIsDir ? 'kept' : 'copied');
}

/**
 * 执行迁移。
 *
 * @param {{from:string, to:string, force?:boolean, dryRun?:boolean, log?:(m:string)=>void, now?:()=>number}} opts
 * @returns {{
 *   ok: boolean, code?: string, error?: string,
 *   already?: boolean, dryRun?: boolean,
 *   from: string, to: string,
 *   copied?: string[], kept?: string[], skipped?: string[],
 *   configs?: Array<{from:string,to:string,result:string}>,
 *   workspace?: string|null,
 *   reportFile?: string,
 *   legacyUntouched?: boolean,
 * }}
 */
export function migrateHome({ from, to, force = false, dryRun = false, log = () => {}, now = Date.now } = {}) {
  const base = { from: path.resolve(String(from ?? '')), to: path.resolve(String(to ?? '')) };
  if (!from || !to) return fail(base, 'NEED_PATHS', '要同时给出 --from 与 --to（或让工具按平台默认值推断）');
  if (base.from === base.to) return fail(base, 'SAME_PATH', '新旧目录是同一个，没什么可迁的');
  if (isInside(base.to, base.from) || isInside(base.from, base.to)) {
    return fail(base, 'NESTED_PATH', '新旧目录互为父子目录，拒绝迁移（会把自己复制进自己）');
  }
  if (!hasLegacyData(base.from)) return fail(base, 'NO_LEGACY', `旧目录里没有可迁移的数据：${base.from}`);

  const reportFile = path.join(base.to, MIGRATION_REPORT);
  const previous = readJson(reportFile);
  if (previous && !dryRun) {
    // 幂等：报告在 = 上次已经成功迁过
    return {
      ok: true,
      already: true,
      from: base.from,
      to: base.to,
      workspace: previous.workspace ?? null,
      reportFile,
      legacyUntouched: true,
    };
  }

  const targetHasState = fs.existsSync(path.join(base.to, 'state.json'));
  if (targetHasState && !force) {
    return fail(
      base,
      'TARGET_HAS_DATA',
      `新目录里已经有数据了：${base.to}`
        + '（确认要合并请加 --force：只会补齐缺失文件，不覆盖任何已有文件）',
    );
  }

  const copied = [];
  const merged = [];
  const kept = [];
  const skipped = [];
  for (const name of ENTRIES) {
    const result = copyEntry(path.join(base.from, name), path.join(base.to, name), { dryRun });
    if (result === 'copied') copied.push(name);
    else if (result === 'merged') merged.push(name);
    else if (result === 'kept') kept.push(name);
    else skipped.push(name);
  }

  const configs = CONFIG_RENAMES.map(({ from: oldName, to: newName }) => {
    const result = copyEntry(path.join(base.from, oldName), path.join(base.to, newName), { dryRun });
    return { from: oldName, to: newName, result };
  });

  // 会话引用：state.json 里存的是**绝对路径**，只复制文件不改路径的话，
  // 服务端会继续写旧目录 —— 那样删掉旧目录就真丢了这些会话。
  let sessionsRewritten = 0;
  if (!dryRun && fs.existsSync(path.join(base.to, 'state.json'))) {
    sessionsRewritten = repairSessionRefs({ dataDir: base.to, log }).rewritten;
  }

  // 工作目录不复制，只记指针（服务端启动时会读它继续用旧 workspace）
  const legacyWorkspace = path.join(base.from, 'workspace');
  const keepWorkspace = fs.existsSync(legacyWorkspace) && fs.statSync(legacyWorkspace).isDirectory();
  const workspace = keepWorkspace ? legacyWorkspace : null;

  const extra = fs.existsSync(base.from)
    ? fs
      .readdirSync(base.from)
      .filter((name) => !ENTRIES.includes(name) && !CONFIG_RENAMES.some((r) => r.from === name))
      .map((name) => (name.startsWith('_') ? '_<测试残留>' : name))
    : [];

  const report = {
    ok: true,
    dryRun,
    from: base.from,
    to: base.to,
    at: new Date(now()).toISOString(),
    copied,
    merged,
    kept,
    skipped,
    configs,
    sessionsRewritten,
    workspace,
    legacyUntouched: true,
    notCopied: [...new Set(extra)],
  };

  if (!dryRun) {
    fs.mkdirSync(base.to, { recursive: true });
    writeJsonAtomic(reportFile, report);
    // 清掉启动护栏留下的"需要迁移"标记：迁完了还挂着只会误导 /health
    fs.rmSync(path.join(base.to, NEEDS_MIGRATION_MARKER), { force: true });
    // 让服务端知道"继续用旧工作目录"（与 data-migration.js 同一个标记文件）
    if (workspace && !fs.existsSync(path.join(base.to, MIGRATION_MARKER))) {
      writeJsonAtomic(path.join(base.to, MIGRATION_MARKER), {
        from: base.from,
        at: report.at,
        entries: copied,
        sessionsRewritten,
        workspace,
      });
    }
    log(
      `[migrate] 已复制 ${copied.length} 项：${base.from} → ${base.to}\n` +
        `         保留（新目录已有）：${kept.join('、') || '（无）'}\n` +
        `         旧目录没有：${skipped.join('、') || '（无）'}\n` +
        (workspace ? `         工作目录没搬，继续用：${workspace}\n` : '') +
        '         旧目录一个字节没动。',
    );
  }

  return { ...report, reportFile };
}

function fail(base, code, error) {
  return { ok: false, code, error, from: base.from, to: base.to };
}
