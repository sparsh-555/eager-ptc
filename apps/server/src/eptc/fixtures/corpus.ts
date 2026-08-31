export const CORPUS: { name: string; source: string }[] = [
  { name: "pure fan-out", source: 'await readFile("a"); await grep("x", "b");' },
  { name: "two-level chain", source: 'const value = await readFile("a"); await grep(value, "b");' },
  { name: "diamond", source: 'const left = await readFile("a"); const right = await readFile("b"); await grep(left, right);' },
  { name: "literal loop", source: 'for (const path of ["a", "b"]) await readFile(path);' },
  { name: "tainted iterable", source: 'const paths = await readFile("list"); for (const path of paths) await readFile(path);' },
  { name: "tainted argument", source: "await readFile(process.env.PATH);" },
  { name: "side effect on main path", source: 'await readFile("a"); await writeFile("out", "x"); await readFile("out");' },
  { name: "side effect under tainted predicate", source: 'if (process.env.FLAG) await writeFile("out", "x");' },
  { name: "single call", source: 'await notify("test", "hello");' },
  { name: "repeated deterministic", source: 'await readFile("same"); await readFile("same");' },
  { name: "repeated non-deterministic shaped", source: 'await notify("test", "same"); await notify("test", "same");' },
  { name: "mixed", source: 'const a = await readFile("a"); await grep("x", "b"); await writeFile("out", a); if (process.env.FLAG) await notify("test", "done"); await readFile("out");' },
];
