/**
 * T2.3 注入点的归一化（纯逻辑，不读盘、不建实例）。
 *
 * 为什么单独一个模块：`pi-runner.js` 是**外观层**，行数预算只有 850 行
 * （`scripts/check-style.mjs` 卡着），构造函数里多放一句解释都塞不下。
 * 与其为了省行把注释删掉，不如把"宿主能注入哪些东西、默认值是什么"收在一个
 * 没有任何依赖的函数里 —— 读一处就知道全貌。
 *
 * 约定：全部默认都是"没注入"，此时行为与引入本模块之前**逐字节一致**。
 * 注入进来的 `store` / `bus` / 模型组由宿主所有（`dispose()` 不拆），
 * 这三项在 `sdk/index.js` 里处理；这里只管会进到建会话那一步的几项。
 */

/** 把 `createOrbisRuntime` / `PiRunner` 的选项归一成一份注入描述 */
export function normalizeInjection(opts = {}) {
  return {
    /** 已建好的模型运行时实例：给了就跳过自建（见 `init()`） */
    modelRuntime: opts.modelRuntime ?? null,
    /** 资源加载器工厂 `(defaults) => loader`：不给就用 `sessionApi.DefaultResourceLoader` */
    resourceLoaderFactory: opts.resourceLoaderFactory ?? null,
    /** 宿主追加的工具对象（`defineTool` 产出），过角色与政策同一道过滤 */
    extraCustomTools: Array.isArray(opts.extraCustomTools) ? opts.extraCustomTools : [],
    /** 宿主追加启用名的内置工具 */
    extraToolNames: Array.isArray(opts.extraToolNames) ? opts.extraToolNames : [],
  };
}
