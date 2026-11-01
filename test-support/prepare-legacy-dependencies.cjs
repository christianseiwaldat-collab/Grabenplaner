"use strict";
const { prepareLegacyDependencies } = require("./legacy-dependencies.cjs");
try {
  const arguments_ = process.argv.slice(2), values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index], value = arguments_[index + 1];
    if (!["--target", "--pnpm", "--pnpm-entry"].includes(name) || !value || Object.hasOwn(values, name)) throw new Error("Invalid historical preparation argument");
    values[name] = value;
  }
  console.log(JSON.stringify(prepareLegacyDependencies({ target: values["--target"], pnpmExecutable: values["--pnpm"], pnpmEntry: values["--pnpm-entry"] })));
} catch (error) {
  console.error("Historical dependency preparation rejected: " + error.message);
  process.exitCode = 1;
}
