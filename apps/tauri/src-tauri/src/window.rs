use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const MAX_CONNECTION_ID_LEN: usize = 256;
const MAX_EXTERNAL_URL_LEN: usize = 2048;

#[derive(Clone, Copy)]
enum HistoryKind {
    Messages,
    Logs,
}

impl HistoryKind {
    fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "messages" => Ok(Self::Messages),
            "logs" => Ok(Self::Logs),
            _ => Err("history kind must be messages or logs".to_owned()),
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::Messages => "messages",
            Self::Logs => "logs",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Messages => "Message History",
            Self::Logs => "Log History",
        }
    }
}

fn validate_connection_id(conn_id: &str) -> Result<(), String> {
    if conn_id.is_empty() || conn_id.trim().is_empty() {
        return Err("connection id must not be empty".to_owned());
    }
    if conn_id.len() > MAX_CONNECTION_ID_LEN {
        return Err("connection id is too long".to_owned());
    }
    if conn_id.chars().any(char::is_control) {
        return Err("connection id contains control characters".to_owned());
    }
    Ok(())
}

fn build_history_query(kind: HistoryKind, conn_id: &str) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("history", kind.value());
    serializer.append_pair("connId", conn_id);
    serializer.finish()
}

fn is_authorized_app_navigation(url: &Url) -> bool {
    let bundled_origin = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http", Some("tauri.localhost"), None)
    );
    let development_origin = cfg!(debug_assertions)
        && matches!(
            (url.scheme(), url.host_str(), url.port()),
            ("http", Some("localhost"), Some(5175))
        );
    (bundled_origin || development_origin)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/index.html"
        && url.fragment().is_none()
}

#[tauri::command]
pub async fn window_open_history(
    app: AppHandle,
    kind: String,
    conn_id: String,
) -> Result<(), String> {
    let kind = HistoryKind::parse(&kind)?;
    validate_connection_id(&conn_id)?;

    let label = format!("history-{}", kind.value());
    let query = build_history_query(kind, &conn_id);
    if let Some(window) = app.get_webview_window(&label) {
        let mut url = window.url().map_err(|error| error.to_string())?;
        if !is_authorized_app_navigation(&url) {
            return Err("history window is outside the authorized app origin".to_owned());
        }
        url.set_query(Some(&query));
        window.navigate(url).map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title(kind.title())
    .inner_size(1180.0, 760.0)
    .min_inner_size(920.0, 620.0)
    .on_navigation(is_authorized_app_navigation)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn validate_external_url(value: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > MAX_EXTERNAL_URL_LEN {
        return Err("external URL has an invalid length".to_owned());
    }
    if value.trim() != value || value.chars().any(|character| character.is_control()) {
        return Err("external URL contains unsafe whitespace".to_owned());
    }

    let url = Url::parse(value).map_err(|_| "external URL must be absolute".to_owned())?;
    if url.scheme() != "https"
        || url.cannot_be_a_base()
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("external URL must be credential-free HTTPS".to_owned());
    }
    Ok(url)
}

#[tauri::command]
pub async fn window_open_external(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    open::that_detached(url.as_str()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_history_query, validate_connection_id, validate_external_url, HistoryKind};

    #[test]
    fn history_query_encodes_an_exact_validated_kind_and_connection() {
        assert_eq!(
            build_history_query(HistoryKind::Logs, "conn + / ?"),
            "history=logs&connId=conn+%2B+%2F+%3F"
        );
        assert!(HistoryKind::parse("other").is_err());
        assert!(validate_connection_id("").is_err());
        assert!(validate_connection_id(&"x".repeat(257)).is_err());
    }

    #[test]
    fn external_urls_are_absolute_https_without_credentials() {
        assert!(validate_external_url("https://downloads.example/app.zip").is_ok());
        for value in [
            "http://downloads.example/app.zip",
            "/relative",
            "https://user:pass@example.com",
            " https://example.com",
            "https://example.com\n",
        ] {
            assert!(validate_external_url(value).is_err(), "{value}");
        }
    }
}
