'use strict';

// Confere a tradução: toda frase marcada com t(), m() ou plural() em src/ e media/ precisa estar
// em l10n/en.json, e o dicionário não guarda frases que o código não usa mais. O texto em
// português é a chave. Uso: `node scripts/l10n-check.cjs` (sai com erro e lista o que falta).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const LITERAL = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`;
const CALLS = [
  new RegExp(String.raw`\b(?:t|m)\(\s*(` + LITERAL + String.raw`)`, 'g'),
  new RegExp(String.raw`\bplural\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(` + LITERAL + String.raw`)\s*,\s*(` + LITERAL + String.raw`)`, 'g'),
];

function unquote(literal) {
  const inner = literal.slice(1, -1);
  const text = literal[0] === "'" ? inner.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"').replace(/(^|[^\\])"/g, '$1\\"') : inner.replace(/\\'/g, "'");
  return JSON.parse('"' + text + '"');
}

function sourceFiles() {
  const files = [];
  for (const [directory, extension] of [['src', '.ts'], ['media', '.js']]) {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      if (name.endsWith(extension)) files.push(path.join(root, directory, name));
    }
  }
  return files;
}

function collectKeys(files = sourceFiles()) {
  const keys = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of CALLS) {
      for (const match of text.matchAll(pattern)) {
        for (const literal of match.slice(1)) {
          if (!literal) continue;
          const key = unquote(literal);
          if (!keys.has(key)) keys.set(key, path.relative(root, file));
        }
      }
    }
  }
  return keys;
}

function placeholders(text) {
  return [...new Set(text.match(/\{\d+\}/g) || [])].sort().join(',');
}

function check() {
  const keys = collectKeys();
  const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'en.json'), 'utf8'));
  const missing = [...keys.keys()].filter((key) => typeof dictionary[key] !== 'string');
  const unused = Object.keys(dictionary).filter((key) => !keys.has(key));
  const mismatched = Object.keys(dictionary).filter((key) => keys.has(key) && placeholders(key) !== placeholders(dictionary[key]));
  return { keys, missing, unused, mismatched };
}

module.exports = { collectKeys, check, placeholders };

if (require.main === module) {
  const { keys, missing, unused, mismatched } = check();
  if (missing.length) console.log('Sem tradução:\n' + JSON.stringify(Object.fromEntries(missing.map((key) => [key, ''])), null, 2));
  if (unused.length) console.log('Sem uso no código:\n' + unused.map((key) => '  ' + JSON.stringify(key)).join('\n'));
  if (mismatched.length) console.log('Marcadores {n} diferentes:\n' + mismatched.map((key) => '  ' + JSON.stringify(key)).join('\n'));
  console.log(keys.size + ' frases; ' + missing.length + ' sem tradução, ' + unused.length + ' sem uso, ' + mismatched.length + ' com marcadores diferentes.');
  if (missing.length || unused.length || mismatched.length) process.exitCode = 1;
}
