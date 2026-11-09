use base64::{engine::general_purpose::STANDARD, Engine};

pub fn verify(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
    version: &str,
) -> Result<(), String> {
    let decode = |value: &str| -> Result<String, String> {
        String::from_utf8(STANDARD.decode(value.trim()).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let key =
        minisign_verify::PublicKey::decode(&decode(public_key)?).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, false)
        .map_err(|e| e.to_string())?;
    if signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        != Some(version)
    {
        return Err("Update signature version mismatch".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_signatures_bind_both_artifact_bytes_and_version() {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let public = STANDARD.encode(pair.pk.to_box().unwrap().into_string());
        let signature = minisign::sign(
            Some(&pair.pk),
            &pair.sk,
            &b"update bytes"[..],
            Some("version:0.1.1"),
            None,
        )
        .unwrap();
        let signature = STANDARD.encode(signature.into_string());
        verify(b"update bytes", &signature, &public, "0.1.1").unwrap();
        assert!(verify(b"changed bytes", &signature, &public, "0.1.1").is_err());
        assert!(verify(b"update bytes", &signature, &public, "0.2.0").is_err());
    }
}
