use crate::boundary::is_success_status;
use crate::window::validate_external_url;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const UPDATE_ENDPOINT: &str = "https://mqtt.ineedfull.com/updates/latest.json";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10);
const UPDATE_RESPONSE_MAX_BYTES: usize = 65_536;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    schema_version: u32,
    app_id: String,
    releases: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRelease {
    version: String,
    url: String,
    #[serde(default)]
    force: Option<bool>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: String,
    pub url: String,
    pub force: bool,
    pub description: String,
}

fn validate_version_name(version: &str) -> Result<(), String> {
    if version.trim().is_empty() || version.len() > 128 || version.chars().any(char::is_control) {
        return Err("invalid update version_name".to_owned());
    }
    Ok(())
}

fn current_number_version(version: &str) -> Result<i32, String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return Err("invalid current update version".to_owned());
    }
    let numbers: Vec<i32> = parts
        .iter()
        .map(|part| part.parse::<i32>())
        .collect::<Result<_, _>>()
        .map_err(|_| "invalid current update version".to_owned())?;
    if numbers[0] < 0 || !(0..=999).contains(&numbers[1]) || !(0..=999).contains(&numbers[2]) {
        return Err("current update version exceeds numeric version range".to_owned());
    }
    numbers[0]
        .checked_mul(1_000_000)
        .and_then(|value| value.checked_add(numbers[1] * 1_000 + numbers[2]))
        .ok_or_else(|| "current update version exceeds numeric version range".to_owned())
}

fn update_channel(platform: &str, architecture: &str, appimage: bool) -> Result<String, String> {
    let platform = match platform {
        "macos" | "windows" | "linux" => platform,
        _ => return Err("unsupported update platform".to_owned()),
    };
    let arch = match architecture {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("unsupported update architecture".to_owned()),
    };
    if platform != "macos" && arch != "x64" {
        return Err("unsupported update architecture".to_owned());
    }
    let format = match platform {
        "macos" => "dmg",
        "windows" => "nsis",
        _ if appimage => "appimage",
        _ => "deb",
    };
    Ok(format!("tauri-{platform}-{arch}-{format}"))
}

fn parse_update_manifest(
    body: &[u8],
    channel: &str,
    current_version: &str,
) -> Result<UpdateCheckResult, String> {
    let manifest: UpdateManifest = serde_json::from_slice(body)
        .map_err(|error| format!("invalid update response: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("invalid update schemaVersion".to_owned());
    }
    if manifest.app_id != "ineed-mqtt-tool" {
        return Err("invalid update appId".to_owned());
    }
    let unavailable = || UpdateCheckResult {
        available: false,
        version: current_version.to_owned(),
        url: String::new(),
        force: false,
        description: String::new(),
    };
    let Some(release) = manifest.releases.get(channel) else {
        return Ok(unavailable());
    };
    let release: UpdateRelease = serde_json::from_value(release.clone())
        .map_err(|error| format!("invalid update release: {error}"))?;
    validate_version_name(&release.version)?;
    let release_number = current_number_version(&release.version)?;
    let download_url = validate_external_url(&release.url)?.to_string();
    if release_number <= current_number_version(current_version)? {
        return Ok(unavailable());
    }
    Ok(UpdateCheckResult {
        available: true,
        version: release.version.clone(),
        url: download_url,
        force: release.force.unwrap_or(false),
        description: release.description.clone().unwrap_or_default(),
    })
}

pub async fn update_check() -> Result<UpdateCheckResult, String> {
    validate_external_url(UPDATE_ENDPOINT)?;
    let current_version = env!("CARGO_PKG_VERSION");
    let channel = update_channel(
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var_os("APPIMAGE").is_some(),
    )?;
    current_number_version(current_version)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(UPDATE_ENDPOINT)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !is_success_status(status.as_u16()) {
        return Err(format!("update check failed ({status})"));
    }

    if response
        .content_length()
        .is_some_and(|length| length > UPDATE_RESPONSE_MAX_BYTES as u64)
    {
        return Err("update response is too large".to_owned());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len().saturating_add(chunk.len()) > UPDATE_RESPONSE_MAX_BYTES {
            return Err("update response is too large".to_owned());
        }
        body.extend_from_slice(&chunk);
    }

    parse_update_manifest(&body, &channel, current_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_semantic_version_to_comparable_number() {
        assert_eq!(current_number_version("0.1.0").unwrap(), 1000);
        assert_eq!(current_number_version("1.2.3").unwrap(), 1_002_003);
        assert!(current_number_version("1.1000.0").is_err());
        assert!(current_number_version("1.2.3-beta").is_err());
    }

    #[test]
    fn parses_static_manifest_for_the_installed_channel() {
        let body = br#"{"schemaVersion":1,"appId":"ineed-mqtt-tool","releases":{"tauri-macos-arm64-dmg":{"version":"0.1.1","url":"https://example.com/app","description":"Fixes"}}}"#;
        let result = parse_update_manifest(body, "tauri-macos-arm64-dmg", "0.1.0").unwrap();
        assert!(result.available);
        assert_eq!(result.version, "0.1.1");
        assert_eq!(result.description, "Fixes");
        assert!(
            !parse_update_manifest(body, "tauri-linux-x64-deb", "0.1.0")
                .unwrap()
                .available
        );
        assert!(
            !parse_update_manifest(body, "tauri-macos-arm64-dmg", "0.1.1")
                .unwrap()
                .available
        );
    }

    #[test]
    fn ignores_malformed_releases_for_other_channels() {
        let body = br#"{"schemaVersion":1,"appId":"ineed-mqtt-tool","releases":{"tauri-macos-arm64-dmg":{"version":"0.1.1","url":"https://example.com/app"},"tauri-windows-x64-nsis":null}}"#;
        assert!(
            parse_update_manifest(body, "tauri-macos-arm64-dmg", "0.1.0")
                .unwrap()
                .available
        );
    }

    #[test]
    fn rejects_invalid_static_manifest_and_insecure_release() {
        for body in [
            br#"{"schemaVersion":2,"appId":"ineed-mqtt-tool","releases":{}}"#.as_slice(),
            br#"{"schemaVersion":1,"appId":"another-app","releases":{}}"#.as_slice(),
            br#"{"schemaVersion":1,"appId":"ineed-mqtt-tool","releases":{"tauri-macos-arm64-dmg":{"version":"0.1.1","url":"http://example.com/app"}}}"#.as_slice(),
        ] {
            assert!(parse_update_manifest(body, "tauri-macos-arm64-dmg", "0.1.0").is_err());
        }
    }

    #[test]
    fn identifies_runtime_platform_and_architecture() {
        assert_eq!(
            update_channel("macos", "aarch64", false).unwrap(),
            "tauri-macos-arm64-dmg"
        );
        assert_eq!(
            update_channel("windows", "x86_64", false).unwrap(),
            "tauri-windows-x64-nsis"
        );
        assert_eq!(
            update_channel("linux", "x86_64", false).unwrap(),
            "tauri-linux-x64-deb"
        );
        assert_eq!(
            update_channel("linux", "x86_64", true).unwrap(),
            "tauri-linux-x64-appimage"
        );
        assert!(update_channel("linux", "arm", false).is_err());
        assert!(update_channel("linux", "aarch64", false).is_err());
        assert!(update_channel("windows", "aarch64", false).is_err());
    }
}
