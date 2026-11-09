function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDefault(value) {
  if (typeof value !== 'string' || value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return value;
  return {
    kind: 'string',
    value: value.slice(1, -1).replaceAll(quote + quote, quote),
  };
}

function quotedToken(sql, start, quote, tokenKind) {
  const closing = quote === '[' ? ']' : quote;
  let cursor = start + 1;
  let value = '';
  while (cursor < sql.length) {
    if (sql[cursor] !== closing) {
      value += sql[cursor];
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === closing) {
      value += closing;
      cursor += 2;
      continue;
    }
    return {
      cursor: cursor + 1,
      token: tokenKind === 'string'
        ? { kind: 'string', normalized: `STRING:${JSON.stringify(value)}` }
        : { kind: 'word', normalized: `WORD:${value.toUpperCase()}` },
    };
  }
  throw new Error('unterminated quoted SQL token');
}

function tokenizeSql(sql) {
  const tokens = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const character = sql[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '-' && sql[cursor + 1] === '-') {
      const lineEnd = sql.indexOf('\n', cursor + 2);
      cursor = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }
    if (character === '/' && sql[cursor + 1] === '*') {
      const commentEnd = sql.indexOf('*/', cursor + 2);
      if (commentEnd === -1) throw new Error('unterminated SQL block comment');
      cursor = commentEnd + 2;
      continue;
    }
    if (character === "'") {
      const quoted = quotedToken(sql, cursor, character, 'string');
      tokens.push(quoted.token);
      cursor = quoted.cursor;
      continue;
    }
    if (character === '"' || character === '`' || character === '[') {
      const quoted = quotedToken(sql, cursor, character, 'identifier');
      tokens.push(quoted.token);
      cursor = quoted.cursor;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = cursor + 1;
      while (end < sql.length && /[A-Za-z\d_$]/.test(sql[end])) end += 1;
      tokens.push({
        kind: 'word',
        normalized: `WORD:${sql.slice(cursor, end).toUpperCase()}`,
      });
      cursor = end;
      continue;
    }
    if (/\d/.test(character) || (character === '.' && /\d/.test(sql[cursor + 1]))) {
      const number = sql.slice(cursor).match(
        /^(?:0[xX][A-Fa-f\d]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/,
      )?.[0];
      if (!number) throw new Error('invalid SQL numeric token');
      tokens.push({ kind: 'number', normalized: `NUMBER:${number.toUpperCase()}` });
      cursor += number.length;
      continue;
    }

    const threeCharacters = sql.slice(cursor, cursor + 3);
    const twoCharacters = sql.slice(cursor, cursor + 2);
    if (threeCharacters === '->>') {
      tokens.push({ kind: 'operator', normalized: 'OP:->>' });
      cursor += 3;
      continue;
    }
    if (['!=', '<>', '==', '<=', '>=', '||', '<<', '>>', '->'].includes(twoCharacters)) {
      const equivalent = twoCharacters === '!=' ? '<>' : twoCharacters === '==' ? '=' : twoCharacters;
      tokens.push({ kind: 'operator', normalized: `OP:${equivalent}` });
      cursor += 2;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push({ kind: 'parenthesis', normalized: character });
    } else if ('=<>+-*/%,.&|~'.includes(character)) {
      tokens.push({ kind: 'operator', normalized: `OP:${character}` });
    } else {
      tokens.push({ kind: 'punctuation', normalized: character });
    }
    cursor += 1;
  }
  return tokens;
}

function isWrappedByParentheses(tokens) {
  if (tokens.length < 2 || tokens[0].normalized !== '(' || tokens.at(-1).normalized !== ')') {
    return false;
  }
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].normalized === '(') depth += 1;
    if (tokens[index].normalized === ')') depth -= 1;
    if (depth === 0 && index < tokens.length - 1) return false;
  }
  return depth === 0;
}

function normalizeCheckExpression(tokens) {
  let normalizedTokens = tokens;
  while (isWrappedByParentheses(normalizedTokens)) {
    normalizedTokens = normalizedTokens.slice(1, -1);
  }
  return normalizedTokens.map(token => token.normalized).join(' ');
}

function checkConstraintSemantics(sql) {
  const tokens = tokenizeSql(sql || '');
  const checks = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== 'word' || tokens[index].normalized !== 'WORD:CHECK') continue;
    if (tokens[index + 1]?.normalized !== '(') {
      throw new Error('CHECK constraint is missing an opening parenthesis');
    }
    let depth = 1;
    const expression = [];
    let cursor = index + 2;
    for (; cursor < tokens.length && depth > 0; cursor += 1) {
      if (tokens[cursor].normalized === '(') depth += 1;
      if (tokens[cursor].normalized === ')') depth -= 1;
      if (depth > 0) expression.push(tokens[cursor]);
    }
    if (depth !== 0) throw new Error('CHECK constraint has unbalanced parentheses');
    checks.push(normalizeCheckExpression(expression));
    index = cursor - 1;
  }
  return checks.sort(compareText);
}

function normalizeSqlSemantics(sql) {
  return tokenizeSql(sql || '').map(token => token.normalized).join(' ');
}

function tableSemantics(database, table) {
  const definition = database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table);
  return {
    columns: database.prepare(`PRAGMA table_xinfo(${table})`).all().map(column => ({
      name: column.name,
      type: String(column.type || '').trim().toUpperCase(),
      notnull: Number(column.notnull),
      dflt_value: normalizeDefault(column.dflt_value),
      pk: Number(column.pk),
      hidden: Number(column.hidden),
    })).sort((left, right) => compareText(left.name, right.name)),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map(foreignKey => ({
        id: Number(foreignKey.id),
        seq: Number(foreignKey.seq),
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        on_update: foreignKey.on_update,
        on_delete: foreignKey.on_delete,
        match: foreignKey.match,
      })).sort((left, right) => left.id - right.id || left.seq - right.seq),
    checks: checkConstraintSemantics(definition?.sql),
  };
}

function constrainedIndexSemantics(database, tables, requiredIndexes) {
  const required = new Set(requiredIndexes);
  const indexes = {};
  for (const table of tables) {
    for (const index of database.prepare(`PRAGMA index_list(${table})`).all()) {
      if (!required.has(index.name) && Number(index.unique) !== 1) continue;
      const keyColumns = database.prepare(`PRAGMA index_xinfo(${index.name})`).all()
        .filter(column => Number(column.key) === 1)
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map(column => ({
          seqno: Number(column.seqno),
          name: column.name,
          expressionCid: column.name == null ? Number(column.cid) : null,
          coll: column.coll,
          desc: Number(column.desc),
        }));
      indexes[index.name] = {
        table,
        unique: Number(index.unique),
        partial: Number(index.partial),
        origin: index.origin,
        keyColumns,
        columns: keyColumns.map(column => column.name),
      };
    }
  }
  return Object.fromEntries(Object.entries(indexes).sort(([left], [right]) => compareText(left, right)));
}

function triggerSemantics(database) {
  return database.prepare(`
    SELECT name, tbl_name, sql
    FROM sqlite_schema
    WHERE type = 'trigger'
    ORDER BY name
  `).all().map(trigger => ({
    name: trigger.name,
    table: trigger.tbl_name,
    sql: normalizeSqlSemantics(trigger.sql),
  }));
}

function schemaSemantics(database, tables, requiredIndexes) {
  const sortedTables = [...tables].sort(compareText);
  return {
    tables: Object.fromEntries(sortedTables.map(table => [table, tableSemantics(database, table)])),
    indexes: constrainedIndexSemantics(database, sortedTables, requiredIndexes),
    triggers: triggerSemantics(database),
  };
}

module.exports = {
  checkConstraintSemantics,
  normalizeDefault,
  normalizeSqlSemantics,
  schemaSemantics,
};
