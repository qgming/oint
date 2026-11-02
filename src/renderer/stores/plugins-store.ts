import { create } from "zustand";
import { pluginPanelViewId } from "@/renderer/features/plugins/use-plugin-panels";
import { ipcErrorMessage } from "@/renderer/features/settings/settings-shared";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { PluginCommandView, PluginDiagnostic, PluginView } from "@/shared/contracts/plugin";

/**
 * 插件列表在渲染层的唯一来源。
 *
 * 三个刻意的设计：
 *
 * 1. **`views` 与 `unavailable` 分开**。`views: null` 是「还没加载」，
 *    `views: []` 是「加载完了，一个都没有」，`unavailable` 非空是「**这次 IPC 读不到**」。
 *
 *    ⚠️ 不再是"运行时还没实现"那个意思了 —— 插件运行时早就接上了，
 *    现在它表示真实的读取失败（把 `ipcErrorMessage` 的原文一并显示出来）。
 *    三者对应的界面完全不同（骨架 / 空态 / 空态 + 诊断行），合成一个字段就分不出来了。
 *
 * 2. **`load()` 不抛错**。IPC 通道不存在、主进程抛错，都落进 `unavailable` 并把
 *    `views` 置为空数组。理由：这个模态窗要能**先于插件运行时上线** ——
 *    运行时还没做时，用户该看到「还没有安装任何插件」，而不是一个红屏。
 *
 * 3. **变更类操作由主进程返回完整列表**，这里直接替换。不在渲染层做乐观更新：
 *    启用一个插件可能连带影响别的行（同 id 覆盖、升级时的权限变化），
 *    渲染层猜不准该改哪几行，而猜错的界面比慢一点的界面更糟。
 */
interface PluginsState {
  /** 全部插件；null = 尚未加载 */
  views: PluginView[] | null;
  /** 插件注册的命令；**空数组是正常状态**（没有插件注册命令，或进程没起来） */
  commands: PluginCommandView[];
  /** 运行时未接入 / 加载失败时的可读原因；null = 一切正常 */
  unavailable: string | null;
  /** 诊断记录（诊断分栏用）；null = 尚未加载 */
  diagnostics: PluginDiagnostic[] | null;
  /** 正在启停 / 卸载的那个插件 id（行内转圈）；null = 没有进行中的操作 */
  busyId: string | null;
  /** 最近一次操作的失败原因（就地显示在列表上方）；null = 没有 */
  error: string | null;

  load(): Promise<void>;
  loadDiagnostics(): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  reload(id: string): Promise<void>;
  uninstall(id: string, keepData: boolean): Promise<void>;
  install(): Promise<void>;
  loadDev(): Promise<void>;
  openSurface(id: string, surfaceId: string): Promise<void>;
  /**
   * 插件注册的命令。
   *
   * **与插件列表分开拉**：命令来自**正在跑的进程**，而列表来自磁盘上的清单 ——
   * 一个插件在列表里是「已启用」但进程没起来（握手失败）时，它一个命令都没有。
   * 合在一次请求里会让"列表成功了"看起来像"命令也可用"。
   */
  loadCommands(): Promise<void>;
  runCommand(id: string, args: string, workspaceDir: string): Promise<void>;
  /**
   * 把插件打成 zip 分享出去（弹保存框）。
   *
   * 用户取消**不算失败**（`canceled` 单独回），所以不走 `failure()`：
   * 让取消弹一条红字是最典型的误报。
   */
  exportPlugin(id: string): Promise<void>;
  revealData(id: string): Promise<void>;
  /** 上一次操作的一条中性提示（导出排除了什么之类）；与 error 分开，它不是失败 */
  notice: string | null;
  /** 清掉上一次的失败提示（用户点掉 / 关模态时调） */
  clearError(): void;
}

/**
 * 把一次 IPC 失败写进 store。
 *
 * 所有变更类操作共用它：**失败时保留原来的 views**（不要清空）——
 * 操作失败不该让用户丢掉正在看的列表。
 */
function failure(set: (partial: Partial<PluginsState>) => void, error: unknown): void {
  set({ error: ipcErrorMessage(error), busyId: null });
}

export const usePluginsStore = create<PluginsState>()((set, get) => ({
  views: null,
  commands: [],
  notice: null,
  unavailable: null,
  diagnostics: null,
  busyId: null,
  error: null,

  load: async () => {
    try {
      const views = await window.oint.plugins.list();
      set({ views, unavailable: null });
      /*
        命令跟着列表一起刷：命令来自**正在跑的进程**，而启停会改变"谁在跑"。
        分开手动调的话，用户启用一个带命令的插件之后要等下一次打开命令面板才看到 ——
        而那时他会以为"这个插件没有命令"。
      */
      await get().loadCommands();
    } catch (error) {
      // 通道不存在 / 主进程未就绪：降级为空态 + 一行诊断，而不是把错误抛到界面
      set({ views: [], unavailable: ipcErrorMessage(error) });
    }
  },

  loadDiagnostics: async () => {
    try {
      const diagnostics = await window.oint.plugins.diagnostics();
      set({ diagnostics, unavailable: null });
    } catch (error) {
      set({ diagnostics: [], unavailable: ipcErrorMessage(error) });
    }
  },

  setEnabled: async (id, enabled) => {
    set({ busyId: id, error: null });
    try {
      const result = enabled
        ? await window.oint.plugins.enable(id)
        : await window.oint.plugins.disable(id);
      set({ views: result.views, busyId: null });
      void get().loadCommands();
    } catch (error) {
      failure(set, error);
    }
  },

  reload: async (id) => {
    set({ busyId: id, error: null });
    try {
      const result = await window.oint.plugins.reload(id);
      set({ views: result.views, busyId: null });
      void get().loadCommands();
    } catch (error) {
      failure(set, error);
    }
  },

  uninstall: async (id, keepData) => {
    set({ busyId: id, error: null });
    try {
      const result = await window.oint.plugins.uninstall(id, keepData);
      set({ views: result.views, busyId: null });
      void get().loadCommands();
    } catch (error) {
      failure(set, error);
    }
  },

  install: async () => {
    set({ error: null });
    try {
      const result = await window.oint.plugins.install();
      // 用户取消时 canceled 为真，此时不要动 views（他什么都没做）
      if (!result.canceled) {
        set({ views: result.views });
        void get().loadCommands();
      }
    } catch (error) {
      failure(set, error);
    }
  },

  loadDev: async () => {
    set({ error: null });
    try {
      const result = await window.oint.plugins.loadDev();
      if (!result.canceled) {
        set({ views: result.views });
        void get().loadCommands();
      }
    } catch (error) {
      failure(set, error);
    }
  },

  /*
    openSurface / revealData 是副作用型操作：它们不改列表，所以不走 busyId
    （按钮不该转圈），失败也只写 error —— 列表本身仍然有效。
  */
  openSurface: async (id, surfaceId) => {
    set({ error: null });
    try {
      const result = await window.oint.plugins.openSurface(id, surfaceId);
      /*
        **两类界面由渲染层开，窗口类主进程已经建好了。**

        主进程回答"该开在哪里"，真正把它挂出来的这一步在这里做 ——
        因为面板与模态窗的宿主都是渲染层的 React 组件（右栏的面板槽 / 对话框），
        主进程没有它们的句柄（要建就得发明一个"往渲染层插组件"的机制，
        而面板注册表与 ui-store 里的模态窗状态已经在做这件事）。

        用 `getState()` 而不是 useUiStore 的 hook：store 不是组件，拿不到 hook。
        zustand 的 store 之间互相调用一律走这条路（chat-store 里也是这么写的）。
      */
      if (result.kind === "panel") {
        useUiStore.getState().openRightPanel(pluginPanelViewId(id, surfaceId));
      } else if (result.kind === "modal") {
        useUiStore.getState().openPluginModal(id, surfaceId);
      }
    } catch (error) {
      failure(set, error);
    }
  },

  revealData: async (id) => {
    set({ error: null });
    try {
      await window.oint.plugins.revealData(id);
    } catch (error) {
      failure(set, error);
    }
  },

  /*
    命令与列表分开拉（理由见接口上的说明）。失败**不清空**已有的命令：
    一次拉取失败不该让命令面板里已经能用的条目消失。
  */
  loadCommands: async () => {
    try {
      set({ commands: await window.oint.plugins.commands() });
    } catch {
      set({ commands: [] });
    }
  },

  runCommand: async (id, args, workspaceDir) => {
    set({ error: null });
    try {
      const result = await window.oint.plugins.runCommand(id, args, workspaceDir);
      // 命令失败**不抛**：它有返回值来表达失败，而这里要把它变成界面上的一行提示
      if (!result.ok) set({ error: result.error ?? "插件命令执行失败" });
    } catch (error) {
      failure(set, error);
    }
  },

  exportPlugin: async (id) => {
    set({ error: null, busyId: id });
    try {
      const result = await window.oint.plugins.export(id);
      set({
        busyId: null,
        /*
          被排除的东西要告诉用户（node_modules、超大文件）——
          不说的话他会以为分享包里带着那些，而接收方一装就发现少了东西。
        */
        ...(result.skipped !== undefined && result.skipped.length > 0
          ? { notice: `${result.files ?? 0} 个文件；已排除：${result.skipped.join("、")}` }
          : {}),
      });
    } catch (error) {
      failure(set, error);
    }
  },

  clearError: () => set({ error: null, notice: null }),
}));
