import security from "eslint-plugin-security";

export default [
  { ignores: ["node_modules/**"] },
  security.configs.recommended,
  {
    rules: {
      // Bracket access in this app uses fixed keys or already-validated ids, not request-controlled prototypes.
      "security/detect-object-injection": "off",
      // Filenames are path.join(DATA_DIR or the app dir, a fixed name) or test temp paths. Static files are an allowlist.
      "security/detect-non-literal-fs-filename": "off",
    },
  },
];
