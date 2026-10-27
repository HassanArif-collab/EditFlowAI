/* Load a browser ES module for Node tests.
   The repo has no package.json, so `import()` of .js resolves as CJS. Instead
   we strip `export` keywords, collect the exported names, and evaluate the
   source in the HOST realm via new Function (vm contexts create a separate
   realm whose arrays fail deepStrictEqual prototype checks). */
const fs = require('node:fs');

function loadEsm(filePath, sandbox = {}) {
  let src = fs.readFileSync(filePath, 'utf8');
  src = src.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/import\s+[^;]+?from\s*['"][^'"]+['"];?/g, '');
  src = src.replace(/^\s*import\s+[^;\n]+;?\s*$/gm, '');
  const names = [];
  src = src.replace(
    /^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      names.push(name);
      const decl = kind === 'const' || kind === 'let' ? 'var' : kind;
      return `${decl} ${name}`;
    }
  );
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  const keys = Object.keys(sandbox);
  const body = `${src}\n;return { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => sandbox[k]));
}

module.exports = { loadEsm };
