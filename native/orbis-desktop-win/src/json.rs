//! 最小 JSON（只够这个助手的协议用）。
//!
//! 为什么不引 serde：本助手只用 windows-sys 一个依赖，加 serde + serde_json
//! 会把二进制和构建时间都抬上去，而这里要解析的形状是**固定且很小**的
//! （一个对象，几个数字/字符串/嵌套点）。手写解析器 ~150 行，还能顺手保证
//! 「非法输入绝不 panic，只返回空对象」。
//!
//! 序列化按 `{"k":v,...}` 直出，字符串做完整转义（UTF-8，中文原样输出）。

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
        Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn to_string(&self) -> String {
        let mut out = String::new();
        write_value(self, &mut out);
        out
    }
}

fn write_value(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(n) => {
            let _ = write!(out, "{}", n);
        }
        Json::Float(n) => {
            if n.is_finite() {
                let _ = write!(out, "{}", n);
            } else {
                out.push_str("null");
            }
        }
        Json::Str(s) => write_str(s, out),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Json::Obj(pairs) => {
            out.push('{');
            for (i, (k, val)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_str(k, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// 解析一个 JSON 文档；任何非法输入都返回 `None`（调用方当成空对象）。
pub fn parse(text: &str) -> Option<Json> {
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    skip_ws(&bytes, &mut i);
    let value = parse_value(&bytes, &mut i)?;
    Some(value)
}

fn skip_ws(b: &[char], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], ' ' | '\t' | '\n' | '\r') {
        *i += 1;
    }
}

fn parse_value(b: &[char], i: &mut usize) -> Option<Json> {
    skip_ws(b, i);
    if *i >= b.len() {
        return None;
    }
    match b[*i] {
        '{' => parse_obj(b, i),
        '[' => parse_arr(b, i),
        '"' => parse_str(b, i).map(Json::Str),
        't' => {
            eat(b, i, "true")?;
            Some(Json::Bool(true))
        }
        'f' => {
            eat(b, i, "false")?;
            Some(Json::Bool(false))
        }
        'n' => {
            eat(b, i, "null")?;
            Some(Json::Null)
        }
        _ => parse_number(b, i),
    }
}

fn eat(b: &[char], i: &mut usize, word: &str) -> Option<()> {
    let chars: Vec<char> = word.chars().collect();
    if b.len() < *i + chars.len() {
        return None;
    }
    for (k, c) in chars.iter().enumerate() {
        if b[*i + k] != *c {
            return None;
        }
    }
    *i += chars.len();
    Some(())
}

fn parse_obj(b: &[char], i: &mut usize) -> Option<Json> {
    *i += 1; // {
    let mut pairs: Vec<(String, Json)> = Vec::new();
    skip_ws(b, i);
    if *i < b.len() && b[*i] == '}' {
        *i += 1;
        return Some(Json::Obj(pairs));
    }
    loop {
        skip_ws(b, i);
        let key = parse_str(b, i)?;
        skip_ws(b, i);
        if *i >= b.len() || b[*i] != ':' {
            return None;
        }
        *i += 1;
        let value = parse_value(b, i)?;
        pairs.push((key, value));
        skip_ws(b, i);
        if *i >= b.len() {
            return None;
        }
        match b[*i] {
            ',' => {
                *i += 1;
            }
            '}' => {
                *i += 1;
                return Some(Json::Obj(pairs));
            }
            _ => return None,
        }
    }
}

fn parse_arr(b: &[char], i: &mut usize) -> Option<Json> {
    *i += 1; // [
    let mut items: Vec<Json> = Vec::new();
    skip_ws(b, i);
    if *i < b.len() && b[*i] == ']' {
        *i += 1;
        return Some(Json::Arr(items));
    }
    loop {
        let value = parse_value(b, i)?;
        items.push(value);
        skip_ws(b, i);
        if *i >= b.len() {
            return None;
        }
        match b[*i] {
            ',' => {
                *i += 1;
            }
            ']' => {
                *i += 1;
                return Some(Json::Arr(items));
            }
            _ => return None,
        }
    }
}

fn parse_str(b: &[char], i: &mut usize) -> Option<String> {
    if *i >= b.len() || b[*i] != '"' {
        return None;
    }
    *i += 1;
    let mut out = String::new();
    while *i < b.len() {
        let c = b[*i];
        *i += 1;
        match c {
            '"' => return Some(out),
            '\\' => {
                if *i >= b.len() {
                    return None;
                }
                let esc = b[*i];
                *i += 1;
                match esc {
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    '/' => out.push('/'),
                    'b' => out.push('\u{0008}'),
                    'f' => out.push('\u{000c}'),
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'u' => {
                        // 只支持基本多文种平面（助手的输入里不会有代理对）
                        if *i + 4 > b.len() {
                            return None;
                        }
                        let hex: String = b[*i..*i + 4].iter().collect();
                        *i += 4;
                        let code = u32::from_str_radix(&hex, 16).ok()?;
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    _ => return None,
                }
            }
            c => out.push(c),
        }
    }
    None
}

fn parse_number(b: &[char], i: &mut usize) -> Option<Json> {
    let start = *i;
    if *i < b.len() && (b[*i] == '-' || b[*i] == '+') {
        *i += 1;
    }
    let mut seen_dot = false;
    let mut seen_exp = false;
    while *i < b.len() {
        let c = b[*i];
        if c.is_ascii_digit() {
            *i += 1;
        } else if c == '.' && !seen_dot && !seen_exp {
            seen_dot = true;
            *i += 1;
        } else if (c == 'e' || c == 'E') && !seen_exp {
            seen_exp = true;
            *i += 1;
            if *i < b.len() && (b[*i] == '-' || b[*i] == '+') {
                *i += 1;
            }
        } else {
            break;
        }
    }
    if start == *i {
        return None;
    }
    let text: String = b[start..*i].iter().collect();
    if seen_dot || seen_exp {
        text.parse::<f64>().ok().map(Json::Float)
    } else {
        text.parse::<i64>().ok().map(Json::Int)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_plan() {
        let v = parse(r#"{"plan":{"action":"click","point":{"x":10,"y":-20},"clicks":2}}"#).unwrap();
        let plan = v.get("plan").unwrap();
        assert_eq!(plan.get("action"), Some(&Json::Str("click".into())));
        assert_eq!(plan.get("point").unwrap().get("x"), Some(&Json::Int(10)));
        assert_eq!(plan.get("point").unwrap().get("y"), Some(&Json::Int(-20)));
        assert_eq!(plan.get("clicks"), Some(&Json::Int(2)));
    }

    #[test]
    fn parses_strings_with_escapes() {
        let v = parse(r#"{"title":"a\"b\\c\nd 中文"}"#).unwrap();
        assert_eq!(v.get("title"), Some(&Json::Str("a\"b\\c\nd 中文".into())));
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert_eq!(parse("not json"), None);
        assert_eq!(parse("{"), None);
        assert_eq!(parse(r#"{"a":}"#), None);
    }

    #[test]
    fn serializes_unicode_and_escapes() {
        let v = Json::obj(vec![
            ("t", Json::Str("中文 \"q\" \\ \n".into())),
            ("n", Json::Int(-3)),
            ("b", Json::Bool(true)),
            ("arr", Json::Arr(vec![Json::Int(1), Json::Null])),
        ]);
        let s = v.to_string();
        assert!(s.contains("中文"));
        assert!(s.contains("\\\"q\\\""));
        assert!(s.contains("\\\\"));
        assert!(s.contains("\\n"));
        assert!(s.contains("[1,null]"));
    }
}
