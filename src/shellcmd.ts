/**
 * A command run with `shell: true` goes through cmd.exe on Windows, and cmd.exe reads a forward slash in a program's
 * path as the start of a switch: `.venv/Scripts/python.exe -B x.py` fails with "'.venv' is not recognized".
 * On Windows the program word of each command in the line (the first word, and the first after `&&`, `||`, `&` or `|`)
 * gets backslashes. Arguments, quoted text after the program, URLs and switches are left as they are, since programs
 * read forward slashes in their arguments. On any other platform the line comes back unchanged.
 */
export const forShell = (command: string, platform: string = process.platform): string => {
  if (platform !== "win32") return command;
  let out = "";
  let i = 0;
  let atStart = true;
  let quoted = false;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (atStart) {
      if (ch === " " || ch === "\t" || ch === "(") {
        out += ch;
        i++;
        continue;
      }
      let j = i;
      if (ch === '"') {
        const close = command.indexOf('"', i + 1);
        j = close < 0 ? command.length : close + 1;
      } else {
        while (j < command.length && !/[\s&|<>()]/.test(command.charAt(j))) j++;
      }
      const word = command.slice(i, j);
      const isPath = word.includes("/") && !word.includes("://") && !/^"?\//.test(word);
      out += isPath ? word.split("/").join("\\") : word;
      i = j;
      atStart = false;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "&" || ch === "|")) {
      out += ch;
      i++;
      if (command.charAt(i) === ch) {
        out += ch;
        i++;
      }
      atStart = true;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};
