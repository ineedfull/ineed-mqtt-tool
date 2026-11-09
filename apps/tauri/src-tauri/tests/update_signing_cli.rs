#![cfg(feature = "release-signing")]
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, process::Command};

#[test]
fn release_helper_signs_and_rejects_changed_version_bytes_and_key() {
    let directory =
        std::env::temp_dir().join(format!("mqtt-signature-cli-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let pair =
        minisign::KeyPair::generate_encrypted_keypair(Some("isolated-test-only".into())).unwrap();
    let public = STANDARD.encode(pair.pk.to_box().unwrap().into_string());
    let private = directory.join("private.key");
    fs::write(
        &private,
        STANDARD.encode(pair.sk.to_box(None).unwrap().into_string()),
    )
    .unwrap();
    let artifact = directory.join("update.app.tar.gz");
    let signature = directory.join("update.sig");
    fs::write(&artifact, b"isolated update artifact").unwrap();
    let run = |operation: &str, version: &str, key: &str| {
        Command::new(env!("CARGO_BIN_EXE_update_signature"))
            .arg(operation)
            .arg(&artifact)
            .arg(&signature)
            .arg(version)
            .env("INEED_TAURI_UPDATE_PUBLIC_KEY", key)
            .env("TAURI_SIGNING_PRIVATE_KEY_PATH", &private)
            .env("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "isolated-test-only")
            .output()
            .unwrap()
            .status
            .success()
    };
    assert!(run("sign", "0.1.1", &public));
    assert!(run("verify", "0.1.1", &public));
    assert!(!run("verify", "0.2.0", &public));
    let collection = directory.join("collection");
    fs::create_dir(&collection).unwrap();
    fs::write(collection.join("update.app.tar.gz"), [0x1f, 0x8b, 0x08, 0]).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    // Exercise the actual Node collection builder and its Rust signing subprocess.
    let code = r#"
      import assert from 'node:assert/strict';
      import { writeUpdateCollection, verifyUpdateCollection } from './scripts/update-release.mjs';
      const publicKeys = { tauri: process.env.INEED_TAURI_UPDATE_PUBLIC_KEY };
      const manifest = await writeUpdateCollection(process.env.MQTT_TEST_COLLECTION, {
        version: '0.1.1', buildId: 'isolated-signature', publicKeys,
        artifacts: [{ runtime: 'tauri', platform: 'macos', arch: 'arm64', format: 'app-tar-gz', name: 'update.app.tar.gz' }]
      }, {});
      assert.equal(manifest.feeds[0].target, 'tauri/tauri-macos-aarch64.json');
      await verifyUpdateCollection(process.env.MQTT_TEST_COLLECTION, publicKeys);
    "#;
    let result = Command::new("node")
        .args(["--input-type=module", "-e", code])
        .current_dir(root)
        .env("INEED_TAURI_UPDATE_PUBLIC_KEY", &public)
        .env("TAURI_SIGNING_PRIVATE_KEY_PATH", &private)
        .env("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "isolated-test-only")
        .env("MQTT_TEST_COLLECTION", &collection)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "collection builder failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let other = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let other = STANDARD.encode(other.pk.to_box().unwrap().into_string());
    assert!(!run("verify", "0.1.1", &other));
    fs::write(&artifact, b"modified update artifact").unwrap();
    assert!(!run("verify", "0.1.1", &public));
}
