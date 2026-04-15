/**
 * compiler.js
 * Genesis — Stage 3: JSONFlow → multi-language code (9 targets)
 *
 * Copyright (c) 2026 Sovereign OS Contributors
 *
 * This file is part of Sovereign Net OS / DDC Infrastructure.
 * Licensed under the Sovereign OS Community License (LICENSE-COMMUNITY).
 * Commercial use requires a separate Commercial License (LICENSE-COMMERCIAL).
 *
 * Core invariant: VM_stateₙ = deriveState(eventLog[0…n])
 *
 * Retain this notice in all copies and derivative works.
 */
// js/compiler.js — Stage 3: JSONFlow → multi-language code compiler
'use strict';

// ─── Type + default helpers ───────────────────────────────────────────────────
function jfT(jsonType, lang) {
  const raw  = (typeof jsonType === 'object' ? jsonType?.type : jsonType) || 'string';
  const norm = { int:'integer', float:'number', bool:'boolean', str:'string', dict:'object', list:'array' };
  const t    = norm[raw.toLowerCase()] || raw.toLowerCase();
  const LANG_ANY = { java:'Object', csharp:'object', rust:'serde_json::Value', go:'interface{}', swift:'Any', kotlin:'Any', typescript:'unknown', javascript:'any', python:'Any' };
  return JF_TYPES[t]?.[lang] || LANG_ANY[lang] || 'Any';
}

function jfDef(jsonType, lang) {
  const raw  = (typeof jsonType === 'object' ? jsonType?.type : jsonType) || 'string';
  const norm = { int:'integer', float:'number', bool:'boolean', str:'string', dict:'object', list:'array' };
  const t    = norm[raw.toLowerCase()] || raw.toLowerCase();
  return JF_DEFAULTS[t]?.[lang] || 'null';
}

// ─── Expression code generator ────────────────────────────────────────────────
function jfExpr(expr, lang) {
  if (expr === null) return ['null', 'null'];
  if (typeof expr === 'boolean') return [(['python','haskell'].includes(lang) ? (expr ? 'True' : 'False') : (expr ? 'true' : 'false')), 'boolean'];
  if (typeof expr === 'number')  return [String(expr), Number.isInteger(expr) ? 'integer' : 'number'];
  if (typeof expr === 'string')  return [`"${expr.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`, 'string'];
  if (typeof expr !== 'object')  return [String(expr), 'string'];

  if ('get' in expr) {
    const ref = expr.get;
    if (Array.isArray(ref) && ref.length >= 2) {
      // ref[0] is always a variable identifier — use it directly rather than
      // routing through jfExpr which would quote a bare string as a literal.
      const r0 = ref[0];
      let base = (typeof r0 === 'string') ? r0 : jfExpr(r0, lang)[0];
      for (let i = 1; i < ref.length; i++) {
        const key = jfExpr(ref[i], lang)[0];
        // Each language has its own map/object property-access syntax
        switch (lang) {
          case 'java':
            base = `((java.util.Map<?,?>)${base}).get(${key})`;
            break;
          case 'kotlin':
            base = `(${base} as? Map<*,*>)?.get(${key})`;
            break;
          case 'csharp':
            base = `((Dictionary<string,object>)${base})[${key}]`;
            break;
          case 'go':
            base = `${base}[${key}]`;
            break;
          case 'rust':
            base = `${base}.get(${key}).and_then(|v| v.as_str()).unwrap_or_default()`;
            break;
          default:
            base += `[${key}]`;
        }
      }
      return [base, 'string'];
    }
    return [String(ref), 'string'];
  }

  if ('value' in expr) {
    const v = expr.value;
    if (typeof v === 'string')  return [`"${v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`, 'string'];
    if (typeof v === 'boolean') return [(['python','haskell'].includes(lang) ? (v ? 'True' : 'False') : (v ? 'true' : 'false')), 'boolean'];
    return [String(v), typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : 'string'];
  }

  for (const [op, sym] of [['add','+'],['subtract','-'],['multiply','*'],['divide','/'],['mod','%']]) {
    if (op in expr) {
      const items = expr[op].map(i => jfExpr(i, lang));
      const code  = items.map(([c]) => (c.includes(' ') && !c.startsWith('"')) ? `(${c})` : c).join(` ${sym} `);
      return [code, items.some(([,t]) => t === 'number') ? 'number' : 'integer'];
    }
  }

  for (const [op, defSym] of [['and','&&'],['or','||']]) {
    if (op in expr) {
      const syms = { python:'and', elixir:'and', lua:'and', ruby:'&&' };
      const sym  = (op === 'and' ? syms : { python:'or', elixir:'or', lua:'or', ruby:'||' })[lang] || defSym;
      return [expr[op].map(i => `(${jfExpr(i, lang)[0]})`).join(` ${sym} `), 'boolean'];
    }
  }

  if ('not' in expr) {
    const [v] = jfExpr(expr.not, lang);
    return [(['python','elixir'].includes(lang) ? `not (${v})` : `!(${v})`), 'boolean'];
  }

  if ('neg' in expr) { const [v,t] = jfExpr(expr.neg, lang); return [`-(${v})`, t]; }

  if ('compare' in expr) {
    const c      = expr.compare;
    const [l]    = jfExpr(c.left, lang);
    const [r]    = jfExpr(c.right, lang);
    const strict = ['javascript','typescript'].includes(lang);
    const opMap  = { '===': strict ? '===' : '==', '!==': strict ? '!==' : '!=', '==': strict ? '===' : '==', '>':'>','<':'<','>=':'>=','<=':'<=' };
    return [`${l} ${opMap[c.op] || c.op} ${r}`, 'boolean'];
  }

  if ('length' in expr) {
    const [v] = jfExpr(expr.length, lang);
    const m   = { python:`len(${v})`, javascript:`${v}.length`, typescript:`${v}.length`, rust:`${v}.len()`, go:`len(${v})`, java:`${v}.size()`, csharp:`${v}.Count`, swift:`${v}.count`, kotlin:`${v}.size` };
    return [m[lang] || `${v}.length`, 'integer'];
  }

  if ('concat' in expr) {
    const parts = expr.concat.map(p => jfExpr(p, lang)[0]);
    const code  = lang === 'python' ? parts.map(p => p.startsWith('"') ? p : `str(${p})`).join(' + ')
      : lang === 'lua' ? parts.join(' .. ')
      : lang === 'rust' ? `[${parts.join(', ')}].concat()`
      : parts.join(' + ');
    return [code, 'string'];
  }

  // Object literal: { "object": { "key": expr, ... } }
  if ('object' in expr) {
    const entries = Object.entries(expr.object).map(([k, v]) => {
      const [valCode] = jfExpr(v, lang);
      return `"${k}": ${valCode}`;
    });
    switch (lang) {
      case 'python': return [`{${entries.join(', ')}}`, 'object'];
      case 'go':     return [`map[string]interface{}{${entries.join(', ')}}`, 'object'];
      default:       return [`{ ${entries.join(', ')} }`, 'object'];
    }
  }

  // Unknown expression node — emit a readable TODO comment rather than raw JSON
  const nodeStr = JSON.stringify(expr).replace(/"/g, "'");
  return [`/* TODO: unsupported expr ${nodeStr} */`, 'string'];
}

// ─── Rewrite get-refs for context vars ───────────────────────────────────────
function rwCtx(expr, ctxVars, prefix) {
  if (!prefix || !ctxVars.size || typeof expr !== 'object' || !expr) return expr;
  const out = {};
  for (const [k, v] of Object.entries(expr)) {
    if (k === 'get') {
      if (typeof v === 'string' && ctxVars.has(v))           out[k] = prefix + v;
      else if (Array.isArray(v)) {
        const a = [...v];
        if (a.length && ctxVars.has(a[0])) a[0] = prefix + a[0];
        out[k] = a;
      } else out[k] = v;
    } else if (Array.isArray(v)) out[k] = v.map(x => typeof x === 'object' ? rwCtx(x, ctxVars, prefix) : x);
    else if (typeof v === 'object' && v) out[k] = rwCtx(v, ctxVars, prefix);
    else out[k] = v;
  }
  return out;
}

// ─── Step code generator ──────────────────────────────────────────────────────
function jfSteps(steps, lang, cfg, indent, ctxPrefix, ctxVars) {
  indent    = indent    ?? 1;
  ctxPrefix = ctxPrefix ?? '';
  ctxVars   = ctxVars   ?? new Set();
  const pad  = (cfg.indent_str || '    ').repeat(indent);
  const sEnd = cfg.stmt_end ?? ';';
  const aOp  = cfg.assign_op ?? ' = ';
  const blk  = cfg.block_close ?? '}';
  const cmt  = cfg.comment || (t => `// ${t}`);
  const lines = [];

  // Coerce bare identifier strings to {get:name} so the LLM can omit the wrapper
  function coerceExpr(node) {
    if (typeof node !== 'string') return node;
    const s = node.trim();
    // Bare identifier: "eventLog" -> {get:"eventLog"}
    if (/^[a-zA-Z_$][a-zA-Z0-9_.]*$/.test(s)) return { get: s };
    // LLM wrote the expression as text: '{ get: "eventLog" }' or "{ get: 'eventLog' }"
    const getMatch = s.match(/^\{\s*["\'\']?get["\'\']?\s*:\s*["\'\']([^\"\'\']+)["\'\']\s*\}$/);
    if (getMatch) return { get: getMatch[1] };
    // General stringified object/array with unquoted keys -> try parsing
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return JSON.parse(s); } catch {}
      const jsonLike = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '$1"$2"$3');
      try { return JSON.parse(jsonLike); } catch {}
    }
    return node;
  }
  function ex(node) { return jfExpr(rwCtx(coerceExpr(node), ctxVars, ctxPrefix), lang)[0]; }
  function sub(ss, extra) { return jfSteps(ss, lang, cfg, indent + (extra || 1), ctxPrefix, ctxVars); }

  for (const step of (steps || [])) {
    if (typeof step !== 'object') continue;
    const st = step.type;

    if (st === 'set') {
      let val; try { val = ex(step.value); } catch { val = JSON.stringify(step.value); }
      const tpfx = ctxVars.has(step.target) ? ctxPrefix : '';
      if (cfg.set_stmt) lines.push(pad + cfg.set_stmt(step.target, val, ctxPrefix));
      else lines.push(`${pad}${tpfx}${step.target}${aOp}${val}${sEnd}`);

    } else if (st === 'return') {
      let val; try { val = step.value !== undefined ? ex(step.value) : ''; } catch { val = String(step.value); }
      const fn = cfg.return_stmt || (v => `return ${v}${sEnd}`);
      lines.push(pad + fn(val));

    } else if (st === 'if') {
      let cond; try { cond = ex(step.condition); } catch { cond = 'true'; }
      lines.push(pad + (cfg.if_open || (c => `if (${c}) {`))(cond));
      lines.push(...sub(step.then || []));
      if (step.else) {
        lines.push(pad + (cfg.else_open || '} else {'));
        lines.push(...sub(step.else));
      }
      lines.push(pad + blk);

    } else if (st === 'while') {
      let cond; try { cond = ex(step.condition); } catch { cond = 'true'; }
      lines.push(pad + (cfg.while_open || (c => `while (${c}) {`))(cond));
      lines.push(...sub(step.body || []));
      lines.push(pad + blk);

    } else if (st === 'foreach') {
      const rawIter = step.iterable || step.collection;
      let coll; try { coll = ex(rawIter); } catch { coll = '[]'; }
      // Guard: if coll still looks like a quoted string expression, it means the iterable
      // resolved to a string literal — fall back to eventLog as the safe default
      if (coll.startsWith('"') || coll.startsWith("'")) {
        const name = coll.replace(/^['"]|['"]$/g, '');
        coll = /^[a-zA-Z_$][a-zA-Z0-9_.]*$/.test(name) ? name : 'eventLog';
      }
      const it = step.item_var || step.iterator || '_item';
      lines.push(pad + (cfg.foreach_open || ((i, c) => `for (const ${i} of ${c}) {`))(it, coll));
      lines.push(...sub(step.body || []));
      lines.push(pad + (cfg.block_close_foreach || blk));

    } else if (st === 'assert') {
      let cond; try { cond = ex(step.condition); } catch { cond = 'true'; }
      const fn = cfg.assert_stmt || ((c, m) => `assert ${c}${sEnd} // ${m}`);
      lines.push(pad + fn(cond, step.message || 'Assertion failed'));

    } else if (st === 'log') {
      const lvl = (step.level || 'info').toUpperCase();
      let msg; try { msg = ex(step.message || '""'); } catch { msg = JSON.stringify(step.message); }
      if (cfg.log_stmt) lines.push(pad + cfg.log_stmt(lvl, msg));
      else lines.push(pad + cmt(`log(${lvl}): ${msg}`));

    } else if (st === 'try') {
      lines.push(pad + (cfg.try_open || 'try {'));
      lines.push(...sub(step.body || []));
      if (step.catch) {
        const ev = step.catch.error_var || 'e';
        lines.push(pad + (cfg.catch_open || (v => `} catch (${v}) {`))(ev));
        lines.push(...sub(step.catch.body || []));
      }
      if (step.finally) {
        lines.push(pad + (cfg.finally_open || '} finally {'));
        lines.push(...sub(step.finally));
      }
      lines.push(pad + blk);

    } else {
      lines.push(pad + cmt(`[${st}]`));
    }
  }
  return lines;
}

// ─── Per-language full compiler ────────────────────────────────────────────────
function jfCompile(flow, lang) {
  const cfg = LANG_CFGS[lang];
  if (!cfg) return `// Language "${lang}" not yet supported in browser.\n// Export JSONFlow JSON and run the Python CLI compiler:\n//   python main.py flow.json --langs ${lang}`;

  const fn      = flow.function || 'flow';
  const schema  = flow.schema || {};
  const inputs  = schema.inputs  || {};
  const context = schema.context || {};
  const outputs = schema.outputs || {};
  const steps   = flow.steps || [];
  const ctxVars = new Set(Object.keys(context));
  const bodyLines = jfSteps(steps, lang, cfg, 1, lang === 'python' ? 'ctx.' : '', ctxVars);

  const retSpec = outputs[Object.keys(outputs)[0]];
  const retType = jfT(retSpec, lang);
  const retDef  = jfDef(retSpec, lang);

  const gens = {
    python: () => {
      const params = Object.entries(inputs).map(([n,s]) => `${n}: ${jfT(s,lang)} = ${jfDef(s,lang)}`).join(', ');
      const lines = [
        `# JSONFlow → Python 3.10+  |  function: ${fn}`,
        `# Generated by Genesis→JSONFlow→Code pipeline`,
        `from __future__ import annotations`,
        `from typing import Any, Dict, List, Optional`, ``,
        `class _Ctx:`,
        ...Object.entries(context).map(([n,s]) => `    ${n}: ${jfT(s,lang)} = ${jfDef(s,lang)}`),
        Object.keys(context).length === 0 ? '    pass' : '',
        ``,
        `def ${fn}(${params}) -> ${retType}:`,
        `    ctx = _Ctx()`,
        ...bodyLines,
        `    return ${retDef}`,
        ``,
        `if __name__ == "__main__":`,
        `    import sys, json`,
        `    _a = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}`,
        `    print(${fn}(**_a))`,
      ];
      return lines.filter(l => l !== null).join('\n') + '\n';
    },
    javascript: () => {
      const params   = Object.keys(inputs).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `  let ${n} = ${jfDef(s,lang)};`);
      return [
        `// JSONFlow → JavaScript ES2022  |  function: ${fn}`,
        `'use strict';`, ``,
        `function ${fn}(${params}) {`,
        ...ctxInits, ...bodyLines,
        `  return ${retDef};`,
        `}`, ``,
        `if (typeof module !== 'undefined') module.exports = { ${fn} };`,
      ].join('\n') + '\n';
    },
    typescript: () => {
      const params   = Object.entries(inputs).map(([n,s]) => `${n}: ${jfT(s,lang)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `  let ${n}: ${jfT(s,lang)} = ${jfDef(s,lang)};`);
      return [
        `// JSONFlow → TypeScript 5.x  |  function: ${fn}`, ``,
        `export function ${fn}(${params}): ${retType} {`,
        ...ctxInits, ...bodyLines,
        `  return ${retDef};`,
        `}`,
      ].join('\n') + '\n';
    },
    rust: () => {
      const snakeFn  = toSnake(fn);
      const params   = Object.entries(inputs).map(([n,s]) => `${toSnake(n)}: ${jfT(s,lang)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `    let mut ${toSnake(n)}: ${jfT(s,lang)} = ${jfDef(s,lang)};`);
      const imports  = ['use std::collections::HashMap;'];
      if (retType.includes('Value') || Object.values(inputs).some(s => jfT(s,lang).includes('Value')))
        imports.push('use serde_json::Value;');
      return [
        `// JSONFlow → Rust  |  function: ${fn}`,
        ...imports, ``,
        `pub fn ${snakeFn}(${params}) -> ${retType} {`,
        ...ctxInits, ...bodyLines,
        `    ${retDef}`,
        `}`, ``,
        `#[cfg(test)]`,
        `mod tests {`,
        `    use super::*;`,
        `    #[test]`,
        `    fn test_${snakeFn}() {`,
        `        // TODO: add assertions`,
        `    }`,
        `}`,
      ].join('\n') + '\n';
    },
    go: () => {
      const pascalFn = toPascal(fn);
      const params   = Object.entries(inputs).map(([n,s]) => `${n} ${jfT(s,lang)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `\tvar ${n} ${jfT(s,lang)} = ${jfDef(s,lang)}`);
      return [
        `// JSONFlow → Go  |  function: ${fn}`,
        `package main`, ``,
        `import "fmt"`, ``,
        `func ${pascalFn}(${params}) ${retType} {`,
        ...ctxInits, ...bodyLines,
        `\treturn ${retDef}`,
        `}`, ``,
        `func main() {`,
        `\tfmt.Println(${pascalFn}(${Object.values(inputs).map(s => jfDef(s,'go')).join(', ')}))`,
        `}`,
      ].join('\n') + '\n';
    },
    java: () => {
      const cls      = toPascal(fn);
      const params   = Object.entries(inputs).map(([n,s]) => `${jfT(s,lang)} ${toCamel(n)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `        ${jfT(s,lang)} ${n} = ${jfDef(s,lang)};`);
      return [
        `// JSONFlow → Java 17+  |  function: ${fn}`,
        `import java.util.*;`, ``,
        `public class ${cls} {`,
        `    public static ${retType} ${toCamel(fn)}(${params}) {`,
        ...ctxInits, ...bodyLines,
        `        return ${retDef};`,
        `    }`,
        `    public static void main(String[] args) {`,
        `        System.out.println(${toCamel(fn)}(${Object.values(inputs).map(s => jfDef(s,'java')).join(', ')}));`,
        `    }`,
        `}`,
      ].join('\n') + '\n';
    },
    csharp: () => {
      const params   = Object.entries(inputs).map(([n,s]) => `${jfT(s,lang)} ${toCamel(n)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `        ${jfT(s,lang)} ${n} = ${jfDef(s,lang)};`);
      return [
        `// JSONFlow → C# (.NET 8)  |  function: ${fn}`,
        `using System;`,
        `using System.Collections.Generic;`,
        `using System.Diagnostics;`, ``,
        `public static class ${toPascal(fn)}Module {`,
        `    public static ${retType} ${toPascal(fn)}(${params}) {`,
        ...ctxInits, ...bodyLines,
        `        return ${retDef};`,
        `    }`,
        `    public static void Main() {`,
        `        Console.WriteLine(${toPascal(fn)}(${Object.values(inputs).map(s => jfDef(s,'csharp')).join(', ')}));`,
        `    }`,
        `}`,
      ].join('\n') + '\n';
    },
    swift: () => {
      const params   = Object.entries(inputs).map(([n,s]) => `${n}: ${jfT(s,lang)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `    var ${n}: ${jfT(s,lang)} = ${jfDef(s,lang)}`);
      return [
        `// JSONFlow → Swift 5.9  |  function: ${fn}`,
        `import Foundation`, ``,
        `func ${fn}(${params}) -> ${retType} {`,
        ...ctxInits, ...bodyLines,
        `    return ${retDef}`,
        `}`, ``,
        `print(${fn}(${Object.entries(inputs).map(([n,s]) => `${n}: ${jfDef(s,'swift')}`).join(', ')}))`,
      ].join('\n') + '\n';
    },
    kotlin: () => {
      const params   = Object.entries(inputs).map(([n,s]) => `${n}: ${jfT(s,lang)}`).join(', ');
      const ctxInits = Object.entries(context).map(([n,s]) => `    var ${n}: ${jfT(s,lang)} = ${jfDef(s,lang)}`);
      return [
        `// JSONFlow → Kotlin  |  function: ${fn}`, ``,
        `fun ${fn}(${params}): ${retType} {`,
        ...ctxInits, ...bodyLines,
        `    return ${retDef}`,
        `}`, ``,
        `fun main() {`,
        `    println(${fn}(${Object.values(inputs).map(s => jfDef(s,'kotlin')).join(', ')}))`,
        `}`,
      ].join('\n') + '\n';
    },
  };
  return gens[lang] ? gens[lang]() : `// Language not supported\n`;
}

// ─── Compile current selected program ─────────────────────────────────────────
function compileCurrentProgram() {
  const lang = document.getElementById('langSelect').value;
  const prog = jfPrograms[selectedJfIdx];
  if (!prog) { addMsg('system', 'No JSONFlow program selected'); return; }
  const code = jfCompile(prog, lang);
  renderCode(lang, code, prog.function);
  setStage(3);
  document.getElementById('badge-code').textContent = '✓';
  switchOutTab('code');
}

// ─── Render + copy + download ──────────────────────────────────────────────────
function renderCode(lang, code, funcName) {
  const d     = document.getElementById('codeDisplay');
  d.innerHTML = '';
  const fname = lang === 'java'
    ? toPascal(funcName) + '.java'
    : `${funcName}${LANG_EXT[lang] || '.txt'}`;

  const block = document.createElement('div');
  block.className = 'code-block';
  block.innerHTML = `
    <div class="code-hdr">
      <span class="code-file">${fname}</span>
      <div class="code-actions">
        <span class="code-file" style="margin-right:8px">${LANG_LABEL[lang] || lang}</span>
        <button class="code-btn" onclick="copyCode()">Copy</button>
        <button class="code-btn" onclick="downloadCode()">Download</button>
      </div>
    </div>
    <div class="code-body"><pre id="codeContent">${escHtml(code)}</pre></div>`;
  d.appendChild(block);
  // Store for copy/download
  d._lang = lang; d._code = code; d._fname = fname;
}

function copyCode() {
  const d = document.getElementById('codeDisplay');
  if (d._code) navigator.clipboard.writeText(d._code);
}

function downloadCode() {
  const d = document.getElementById('codeDisplay');
  if (!d._code) return;
  const a  = document.createElement('a');
  a.href   = URL.createObjectURL(new Blob([d._code], { type: 'text/plain' }));
  a.download = d._fname;
  a.click();
}
