/**
 * 本文件实现 AdapterRegistry（适配器注册表）。
 * 作用：集中管理 adapter（适配器）并按 detect（检测）结果选择当前平台实现。
 */
export class AdapterRegistry {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.adapters = [];
  }

  register(adapter) {
    if (!adapter || typeof adapter.detect !== "function") {
      throw new Error("注册 adapter 失败：实例不合法");
    }

    const existed = this.adapters.find((item) => item.platform === adapter.platform);
    if (existed) {
      this.logger?.warn("重复注册平台 adapter，已覆盖旧实例。", {
        platform: adapter.platform
      });
      this.adapters = this.adapters.filter((item) => item.platform !== adapter.platform);
    }

    this.adapters.push(adapter);
    this.logger?.debug("平台 adapter 注册完成。", {
      platform: adapter.platform,
      count: this.adapters.length
    });
  }

  resolve(context = {}) {
    for (const adapter of this.adapters) {
      try {
        if (adapter.detect(context) === true) {
          this.logger?.info("已选择平台 adapter。", { platform: adapter.platform });
          return adapter;
        }
      } catch (error) {
        this.logger?.warn("平台 adapter detect 执行失败，已跳过。", {
          platform: adapter.platform,
          error
        });
      }
    }

    this.logger?.warn("未匹配到可用平台 adapter。");
    return null;
  }

  get(platform) {
    return this.adapters.find((item) => item.platform === platform) || null;
  }

  list() {
    return [...this.adapters];
  }
}
