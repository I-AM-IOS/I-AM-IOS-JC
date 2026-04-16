/**
 * lang-configs.js
 * JSONFlow — Per-language syntax configuration (indent, ops, keywords)
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
// jsonflow/lang-configs.js — Per-language compiler configs and naming helpers
'use strict';

const LANG_CFGS = {
  python: {
    indent_str:'    ', stmt_end:'', assign_op:' = ', block_close:'',
    if_open:           c     => `if ${c}:`,
    else_open:         'else:',
    while_open:        c     => `while ${c}:`,
    foreach_open:      (i,c) => `for ${i} in ${c}:`,
    block_close_foreach: '',
    return_stmt:       v     => `return ${v}`,
    try_open:          'try:',
    catch_open:        v     => `except Exception as ${v}:`,
    finally_open:      'finally:',
    comment:           t     => `# ${t}`,
    assert_stmt:       (c,m) => `assert ${c}, "${m}"`,
    log_stmt:          (l,m) => `print(f"[${l}] {str(${m.replace(/"/g, "'")})}")`,
    empty_body_stmt:   'pass',   // required: Python disallows empty if/while bodies
    // empty_else_stmt intentionally omitted: empty else blocks are dropped entirely
  },
  javascript: {
    indent_str:'  ', stmt_end:';', assign_op:' = ', block_close:'}',
    if_open:           c     => `if (${c}) {`,
    else_open:         '} else {',
    while_open:        c     => `while (${c}) {`,
    foreach_open:      (i,c) => `for (const ${i} of ${c}) {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v};`,
    try_open:          'try {',
    catch_open:        v     => `} catch (${v}) {`,
    finally_open:      '} finally {',
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `if (!(${c})) throw new Error("${m}");`,
    log_stmt:          (l,m) => `console.log(\`[${l}] \${${m}}\`);`,
  },
  typescript: {
    indent_str:'  ', stmt_end:';', assign_op:' = ', block_close:'}',
    if_open:           c     => `if (${c}) {`,
    else_open:         '} else {',
    while_open:        c     => `while (${c}) {`,
    foreach_open:      (i,c) => `for (const ${i} of ${c}) {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v};`,
    try_open:          'try {',
    catch_open:        v     => `} catch (${v}: unknown) {`,
    finally_open:      '} finally {',
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `if (!(${c})) throw new Error("${m}");`,
    log_stmt:          (l,m) => `console.log(\`[${l}] \${${m}}\`);`,
  },
  rust: {
    indent_str:'    ', stmt_end:';', assign_op:' = ', block_close:'}',
    if_open:           c     => `if ${c} {`,
    else_open:         '} else {',
    while_open:        c     => `while ${c} {`,
    foreach_open:      (i,c) => `for ${i} in ${c} {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v};`,
    try_open:          '// try {',
    catch_open:        v     => `// catch ${v}`,
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `assert!(${c}, "${m}");`,
    log_stmt:          (l,m) => `println!("[{}] {:?}", "${l}", ${m});`,
  },
  go: {
    indent_str:'\t', stmt_end:'', assign_op:' := ', block_close:'}',
    if_open:           c     => `if ${c} {`,
    else_open:         '} else {',
    while_open:        c     => `for ${c} {`,
    foreach_open:      (i,c) => `for _, ${i} := range ${c} {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v}`,
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `if !(${c}) { panic("${m}") }`,
    log_stmt:          (l,m) => `fmt.Printf("[%s] %v\n", "${l}", ${m})`,
  },
  java: {
    indent_str:'    ', stmt_end:';', assign_op:' = ', block_close:'}',
    if_open:           c     => `if (${c}) {`,
    else_open:         '} else {',
    while_open:        c     => `while (${c}) {`,
    foreach_open:      (i,c) => `for (var ${i} : ${c}) {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v};`,
    try_open:          'try {',
    catch_open:        v     => `} catch (Exception ${v}) {`,
    finally_open:      '} finally {',
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `assert ${c} : "${m}";`,
    log_stmt:          (l,m) => `System.out.println("[" + "${l}" + "] " + ${m});`,
  },
  csharp: {
    indent_str:'    ', stmt_end:';', assign_op:' = ', block_close:'}',
    if_open:           c     => `if (${c}) {`,
    else_open:         '} else {',
    while_open:        c     => `while (${c}) {`,
    foreach_open:      (i,c) => `foreach (var ${i} in ${c}) {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v};`,
    try_open:          'try {',
    catch_open:        v     => `} catch (Exception ${v}) {`,
    finally_open:      '} finally {',
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `Debug.Assert(${c}, "${m}");`,
    log_stmt:          (l,m) => `Console.WriteLine($"[${l}] {${m}}");`,
  },
  swift: {
    indent_str:'    ', stmt_end:'', assign_op:' = ', block_close:'}',
    if_open:           c     => `if ${c} {`,
    else_open:         '} else {',
    while_open:        c     => `while ${c} {`,
    foreach_open:      (i,c) => `for ${i} in ${c} {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v}`,
    try_open:          'do {',
    catch_open:        v     => `} catch let ${v} {`,
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `assert(${c}, "${m}")`,
    log_stmt:          (l,m) => `print("[\(${JSON.stringify(l)}) \(${m})")`,
  },
  kotlin: {
    indent_str:'    ', stmt_end:'', assign_op:' = ', block_close:'}',
    if_open:           c     => `if (${c}) {`,
    else_open:         '} else {',
    while_open:        c     => `while (${c}) {`,
    foreach_open:      (i,c) => `for (${i} in ${c}) {`,
    block_close_foreach: '}',
    return_stmt:       v     => `return ${v}`,
    try_open:          'try {',
    catch_open:        v     => `} catch (${v}: Exception) {`,
    finally_open:      '} finally {',
    comment:           t     => `// ${t}`,
    assert_stmt:       (c,m) => `require(${c}) { "${m}" }`,
    log_stmt:          (l,m) => `println("[${l}] \${${m}}")`,
  },
};

// Naming helpers
const toCamel  = s => s.replace(/_([a-z])/g, (_,c) => c.toUpperCase());
const toPascal = s => { const c = toCamel(s); return c.charAt(0).toUpperCase() + c.slice(1); };
const toSnake  = s => s.replace(/([A-Z])/g, m => '_' + m.toLowerCase()).replace(/^_/, '');
