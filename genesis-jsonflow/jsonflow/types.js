/**
 * types.js
 * JSONFlow — Type and default value maps across 9 target languages
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
// jsonflow/types.js — JSONFlow type and default value maps
'use strict';

const JF_TYPES = {
  string:  { python:'str',   javascript:'string',            typescript:'string',           rust:'String',                        go:'string',               java:'String',        csharp:'string',                  swift:'String',   kotlin:'String'   },
  integer: { python:'int',   javascript:'number',            typescript:'number',           rust:'i64',                           go:'int64',                java:'long',          csharp:'long',                    swift:'Int64',    kotlin:'Long'     },
  number:  { python:'float', javascript:'number',            typescript:'number',           rust:'f64',                           go:'float64',              java:'double',        csharp:'double',                  swift:'Double',   kotlin:'Double'   },
  boolean: { python:'bool',  javascript:'boolean',           typescript:'boolean',          rust:'bool',                          go:'bool',                 java:'boolean',       csharp:'bool',                    swift:'Bool',     kotlin:'Boolean'  },
  array:   { python:'list',  javascript:'Array<any>',        typescript:'Array<unknown>',   rust:'Vec<serde_json::Value>',        go:'[]interface{}',        java:'List<Object>',  csharp:'List<object>',            swift:'[Any]',    kotlin:'List<Any>'},
  object:  { python:'dict',  javascript:'Record<string,any>',typescript:'Record<string,unknown>',rust:'HashMap<String,serde_json::Value>',go:'map[string]interface{}',java:'Map<String,Object>',csharp:'Dictionary<string,object>',swift:'[String:Any]',kotlin:'Map<String,Any>'},
};

const JF_DEFAULTS = {
  string:  { python:'""',    javascript:'""',   typescript:'""',   rust:'String::new()', go:'""',                              java:'""',                csharp:'""',                       swift:'""',       kotlin:'""'       },
  integer: { python:'0',     javascript:'0',    typescript:'0',    rust:'0i64',          go:'0',                               java:'0L',                csharp:'0L',                       swift:'Int64(0)', kotlin:'0L'       },
  number:  { python:'0.0',   javascript:'0.0',  typescript:'0.0',  rust:'0.0f64',        go:'0.0',                             java:'0.0',               csharp:'0.0',                      swift:'0.0',      kotlin:'0.0'      },
  boolean: { python:'False', javascript:'false',typescript:'false',rust:'false',          go:'false',                           java:'false',             csharp:'false',                    swift:'false',    kotlin:'false'    },
  array:   { python:'[]',    javascript:'[]',   typescript:'[]',   rust:'Vec::new()',     go:'nil',                             java:'new ArrayList<>()', csharp:'new List<object>()',       swift:'[]',       kotlin:'listOf()' },
  object:  { python:'{}',    javascript:'{}',   typescript:'{}',   rust:'HashMap::new()',go:'make(map[string]interface{})',    java:'new HashMap<>()',   csharp:'new Dictionary<string,object>()',swift:'[:]',kotlin:'mapOf()' },
};

const LANG_EXT   = { python:'.py', javascript:'.js', typescript:'.ts', rust:'.rs', go:'.go', java:'.java', csharp:'.cs', swift:'.swift', kotlin:'.kt' };
const LANG_LABEL = { python:'Python', javascript:'JavaScript', typescript:'TypeScript', rust:'Rust', go:'Go', java:'Java', csharp:'C#', swift:'Swift', kotlin:'Kotlin' };
