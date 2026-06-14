export default defineNuxtConfig({
  compatibilityDate: "2025-08-17",
  devtools: { enabled: false },
  nitro: {
    experimental: {
      bundleRuntimeDependencies: false,
      tasks: false,
    },
  },
  hooks: {
    "nitro:config"(nitroConfig) {
      const rollupConfig = nitroConfig.rollupConfig;
      const plugins = rollupConfig?.plugins;

      if (Array.isArray(plugins)) {
        rollupConfig.plugins = plugins.filter((plugin) => {
          return !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "impound");
        });
      }
    },
  },
});
