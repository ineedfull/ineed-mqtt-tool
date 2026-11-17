// Canonical SQLite schema comparison, including SQL tokens and constraints.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
enum DefaultSemantics {
    None,
    String(String),
    Sql(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnSemantics {
    name: String,
    declared_type: String,
    not_null: i64,
    default: DefaultSemantics,
    primary_key: i64,
    hidden: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ForeignKeySemantics {
    id: i64,
    sequence: i64,
    table: String,
    from: String,
    to: Option<String>,
    on_update: String,
    on_delete: String,
    match_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TableSemantics {
    columns: Vec<ColumnSemantics>,
    foreign_keys: Vec<ForeignKeySemantics>,
    checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexColumnSemantics {
    sequence: i64,
    name: Option<String>,
    expression_column_id: Option<i64>,
    collation: String,
    descending: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexSemantics {
    table: String,
    unique: i64,
    partial: i64,
    origin: String,
    columns: Vec<IndexColumnSemantics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TriggerSemantics {
    name: String,
    table: String,
    sql: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaSemantics {
    tables: BTreeMap<String, TableSemantics>,
    indexes: BTreeMap<String, IndexSemantics>,
    triggers: Vec<TriggerSemantics>,
}

fn normalize_default(value: Option<String>) -> DefaultSemantics {
    let Some(value) = value else {
        return DefaultSemantics::None;
    };
    let mut characters = value.chars();
    let Some(quote) = characters.next() else {
        return DefaultSemantics::Sql(value);
    };
    if (quote == '\'' || quote == '"') && value.ends_with(quote) && value.len() >= 2 {
        let inner = &value[quote.len_utf8()..value.len() - quote.len_utf8()];
        return DefaultSemantics::String(
            inner.replace(&format!("{quote}{quote}"), &quote.to_string()),
        );
    }
    DefaultSemantics::Sql(value)
}

fn quoted_sql_token(
    characters: &[char],
    start: usize,
    quote: char,
    string_literal: bool,
) -> Result<(usize, String), String> {
    let closing = if quote == '[' { ']' } else { quote };
    let mut cursor = start + 1;
    let mut value = String::new();
    while cursor < characters.len() {
        if characters[cursor] != closing {
            value.push(characters[cursor]);
            cursor += 1;
            continue;
        }
        if characters.get(cursor + 1) == Some(&closing) {
            value.push(closing);
            cursor += 2;
            continue;
        }
        let normalized = if string_literal {
            format!("STRING:{value:?}")
        } else {
            format!("WORD:{}", value.to_uppercase())
        };
        return Ok((cursor + 1, normalized));
    }
    Err("unterminated quoted SQL token in schema".into())
}

fn sql_tokens(sql: &str) -> Result<Vec<String>, String> {
    let characters = sql.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < characters.len() {
        let character = characters[cursor];
        if character.is_whitespace() {
            cursor += 1;
            continue;
        }
        if character == '-' && characters.get(cursor + 1) == Some(&'-') {
            cursor += 2;
            while cursor < characters.len() && characters[cursor] != '\n' {
                cursor += 1;
            }
            continue;
        }
        if character == '/' && characters.get(cursor + 1) == Some(&'*') {
            cursor += 2;
            while cursor + 1 < characters.len()
                && !(characters[cursor] == '*' && characters[cursor + 1] == '/')
            {
                cursor += 1;
            }
            if cursor + 1 >= characters.len() {
                return Err("unterminated SQL block comment in schema".into());
            }
            cursor += 2;
            continue;
        }
        if character == '\'' {
            let (next, token) = quoted_sql_token(&characters, cursor, character, true)?;
            tokens.push(token);
            cursor = next;
            continue;
        }
        if character == '"' || character == '`' || character == '[' {
            let (next, token) = quoted_sql_token(&characters, cursor, character, false)?;
            tokens.push(token);
            cursor = next;
            continue;
        }
        if character.is_ascii_alphabetic() || character == '_' || character == '$' {
            let start = cursor;
            cursor += 1;
            while cursor < characters.len()
                && (characters[cursor].is_ascii_alphanumeric()
                    || characters[cursor] == '_'
                    || characters[cursor] == '$')
            {
                cursor += 1;
            }
            tokens.push(format!(
                "WORD:{}",
                characters[start..cursor]
                    .iter()
                    .collect::<String>()
                    .to_uppercase()
            ));
            continue;
        }
        if character.is_ascii_digit()
            || (character == '.' && characters.get(cursor + 1).is_some_and(char::is_ascii_digit))
        {
            let start = cursor;
            if character == '0' && matches!(characters.get(cursor + 1), Some('x' | 'X')) {
                cursor += 2;
                while cursor < characters.len() && characters[cursor].is_ascii_hexdigit() {
                    cursor += 1;
                }
            } else {
                while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                if characters.get(cursor) == Some(&'.') {
                    cursor += 1;
                    while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                        cursor += 1;
                    }
                }
                if matches!(characters.get(cursor), Some('e' | 'E')) {
                    cursor += 1;
                    if matches!(characters.get(cursor), Some('+' | '-')) {
                        cursor += 1;
                    }
                    while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                        cursor += 1;
                    }
                }
            }
            tokens.push(format!(
                "NUMBER:{}",
                characters[start..cursor]
                    .iter()
                    .collect::<String>()
                    .to_uppercase()
            ));
            continue;
        }

        let remaining = characters[cursor..].iter().collect::<String>();
        if remaining.starts_with("->>") {
            tokens.push("OP:->>".into());
            cursor += 3;
            continue;
        }
        let pair = characters
            .get(cursor + 1)
            .map(|next| format!("{character}{next}"));
        if let Some(pair) = pair.filter(|pair| {
            ["!=", "<>", "==", "<=", ">=", "||", "<<", ">>", "->"].contains(&pair.as_str())
        }) {
            let equivalent = match pair.as_str() {
                "!=" => "<>",
                "==" => "=",
                _ => &pair,
            };
            tokens.push(format!("OP:{equivalent}"));
            cursor += 2;
            continue;
        }
        if character == '(' || character == ')' {
            tokens.push(character.to_string());
        } else if "=<>+-*/%,.&|~".contains(character) {
            tokens.push(format!("OP:{character}"));
        } else {
            tokens.push(format!("PUNCT:{character}"));
        }
        cursor += 1;
    }
    Ok(tokens)
}

fn wrapped_by_parentheses(tokens: &[String]) -> bool {
    if tokens.len() < 2
        || tokens.first().map(String::as_str) != Some("(")
        || tokens.last().map(String::as_str) != Some(")")
    {
        return false;
    }
    let mut depth = 0;
    for (index, token) in tokens.iter().enumerate() {
        if token == "(" {
            depth += 1;
        } else if token == ")" {
            depth -= 1;
        }
        if depth == 0 && index < tokens.len() - 1 {
            return false;
        }
    }
    depth == 0
}

fn check_constraint_semantics(sql: &str) -> Result<Vec<String>, String> {
    let tokens = sql_tokens(sql)?;
    let mut checks = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if tokens[index] != "WORD:CHECK" {
            index += 1;
            continue;
        }
        if tokens.get(index + 1).map(String::as_str) != Some("(") {
            return Err("CHECK constraint is missing an opening parenthesis".into());
        }
        let mut depth = 1;
        let mut expression = Vec::new();
        let mut cursor = index + 2;
        while cursor < tokens.len() && depth > 0 {
            if tokens[cursor] == "(" {
                depth += 1;
            } else if tokens[cursor] == ")" {
                depth -= 1;
            }
            if depth > 0 {
                expression.push(tokens[cursor].clone());
            }
            cursor += 1;
        }
        if depth != 0 {
            return Err("CHECK constraint has unbalanced parentheses".into());
        }
        while wrapped_by_parentheses(&expression) {
            expression = expression[1..expression.len() - 1].to_vec();
        }
        checks.push(expression.join(" "));
        index = cursor;
    }
    checks.sort();
    Ok(checks)
}

fn table_semantics(connection: &Connection, table: &str) -> Result<TableSemantics, String> {
    let columns = {
        let mut statement = connection
            .prepare(
                "SELECT name,type,\"notnull\",dflt_value,pk,hidden
                 FROM pragma_table_xinfo(?) ORDER BY name",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([table], |row| {
                Ok(ColumnSemantics {
                    name: row.get(0)?,
                    declared_type: row.get::<_, String>(1)?.trim().to_uppercase(),
                    not_null: row.get(2)?,
                    default: normalize_default(row.get(3)?),
                    primary_key: row.get(4)?,
                    hidden: row.get(5)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    let foreign_keys = {
        let mut statement = connection
            .prepare(
                "SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete,\"match\"
                 FROM pragma_foreign_key_list(?) ORDER BY id,seq",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([table], |row| {
                Ok(ForeignKeySemantics {
                    id: row.get(0)?,
                    sequence: row.get(1)?,
                    table: row.get(2)?,
                    from: row.get(3)?,
                    to: row.get(4)?,
                    on_update: row.get(5)?,
                    on_delete: row.get(6)?,
                    match_type: row.get(7)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    let definition: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
            [table],
            |row| row.get(0),
        )
        .or_else(|error| {
            if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                Ok(None)
            } else {
                Err(error)
            }
        })
        .map_err(database_error)?;
    let checks = check_constraint_semantics(definition.as_deref().unwrap_or(""))?;
    Ok(TableSemantics {
        columns,
        foreign_keys,
        checks,
    })
}

fn schema_semantics(connection: &Connection) -> Result<SchemaSemantics, String> {
    let mut tables = BTreeMap::new();
    for table in REQUIRED_TABLES {
        tables.insert((*table).to_string(), table_semantics(connection, table)?);
    }

    let mut indexes = BTreeMap::new();
    for table in REQUIRED_TABLES {
        let mut statement = connection
            .prepare(
                "SELECT name,\"unique\",origin,partial FROM pragma_index_list(?) ORDER BY name",
            )
            .map_err(database_error)?;
        let listed = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        for (name, unique, origin, partial) in listed {
            if unique == 0 && !REQUIRED_INDEXES.contains(&name.as_str()) {
                continue;
            }
            let mut column_statement = connection
                .prepare(
                    "SELECT seqno,cid,name,coll,desc FROM pragma_index_xinfo(?)
                     WHERE key=1 ORDER BY seqno",
                )
                .map_err(database_error)?;
            let columns = column_statement
                .query_map([&name], |row| {
                    let column_name = row.get::<_, Option<String>>(2)?;
                    Ok(IndexColumnSemantics {
                        sequence: row.get(0)?,
                        expression_column_id: column_name
                            .is_none()
                            .then(|| row.get(1))
                            .transpose()?,
                        name: column_name,
                        collation: row.get(3)?,
                        descending: row.get(4)?,
                    })
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?;
            indexes.insert(
                name,
                IndexSemantics {
                    table: (*table).to_string(),
                    unique,
                    partial,
                    origin,
                    columns,
                },
            );
        }
    }

    let mut trigger_statement = connection
        .prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
        .map_err(database_error)?;
    let triggers = trigger_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?
        .into_iter()
        .map(|(name, table, sql)| {
            Ok(TriggerSemantics {
                name,
                table,
                sql: sql_tokens(&sql)?.join(" "),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(SchemaSemantics {
        tables,
        indexes,
        triggers,
    })
}

pub(super) fn validate_required_schema(connection: &Connection) -> Result<(), String> {
    let canonical = Connection::open_in_memory().map_err(database_error)?;
    canonical
        .execute_batch(BASELINE_SCHEMA)
        .map_err(database_error)?;
    let expected = schema_semantics(&canonical)?;
    let actual = schema_semantics(connection)?;
    for table in REQUIRED_TABLES {
        let expected_table = expected
            .tables
            .get(*table)
            .ok_or_else(|| format!("canonical schema is missing table semantics for {table}"))?;
        let actual_table = actual
            .tables
            .get(*table)
            .ok_or_else(|| format!("database schema is missing table semantics for {table}"))?;
        if actual_table.columns != expected_table.columns {
            return Err(format!(
                "database schema mismatch: {table} columns differ from persistence contract"
            ));
        }
        if actual_table.foreign_keys != expected_table.foreign_keys {
            return Err(format!(
                "database schema mismatch: {table} foreign keys differ from persistence contract"
            ));
        }
        if actual_table.checks != expected_table.checks {
            return Err(format!("database schema mismatch: {table} CHECK constraints differ from persistence contract"));
        }
    }
    if actual.indexes != expected.indexes {
        return Err(
            "database schema mismatch: constrained indexes differ from persistence contract".into(),
        );
    }
    if actual.triggers != expected.triggers {
        return Err("database schema mismatch: triggers differ from persistence contract".into());
    }
    Ok(())
}
