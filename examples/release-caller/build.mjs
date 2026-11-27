import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/hello.mjs", `console.log("hello ${version}");\n`);
