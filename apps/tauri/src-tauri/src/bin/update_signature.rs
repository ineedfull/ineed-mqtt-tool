use base64::{engine::general_purpose::STANDARD, Engine};
use std::{env, fs};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 4 || !["sign", "verify"].contains(&args[0].as_str()) {
        return Err("Usage: update_signature sign|verify artifact signature-file version".into());
    }
    let bytes = fs::read(&args[1])?;
    let public = env::var("INEED_TAURI_UPDATE_PUBLIC_KEY")?;
    if args[0] == "sign" {
        let key_path = env::var("TAURI_SIGNING_PRIVATE_KEY_PATH")?;
        let encoded = fs::read_to_string(key_path)?;
        let text = String::from_utf8(STANDARD.decode(encoded.trim())?)?;
        let private = minisign::SecretKey::from_box(
            minisign::SecretKeyBox::from_string(&text)?,
            Some(env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default()),
        )?;
        let signed = minisign::sign(
            None,
            &private,
            &bytes[..],
            Some(&format!("version:{}", args[3])),
            None,
        )?;
        let signature = STANDARD.encode(signed.into_string());
        ineed_mqtt_tool_lib::update_signature::verify(&bytes, &signature, &public, &args[3])?;
        fs::write(&args[2], signature)?;
    } else {
        ineed_mqtt_tool_lib::update_signature::verify(
            &bytes,
            &fs::read_to_string(&args[2])?,
            &public,
            &args[3],
        )?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Update signature operation failed: {error}");
        std::process::exit(1);
    }
}
