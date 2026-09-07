module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "services-do-not-import-http-routes",
      severity: "error",
      from: { path: "^src/services/" },
      to: { path: "^src/(routes|app|server)" },
    },
    {
      name: "domain-is-independent",
      severity: "error",
      from: { path: "^src/modules/[^/]+/domain/" },
      to: {
        path: "(node_modules/(express|mongoose)|^src/(models|routes|services|middleware|config)/)",
      },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
