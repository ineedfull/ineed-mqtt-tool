export async function publishOnce({ mqtt, connection, topic, payload, qos, retain } = {}) {
  if (
    !connection
    || connection.status !== 'connected'
    || connection.id == null
    || String(connection.id).trim() === ''
  ) {
    return { ok: false, error: '请先连接 MQTT Broker' };
  }

  const normalizedTopic = String(topic ?? '').trim();
  if (!normalizedTopic) {
    return { ok: false, error: '请输入发布 Topic' };
  }
  if (/[+#]|\p{Cc}/u.test(normalizedTopic) || new TextEncoder().encode(normalizedTopic).byteLength > 65_535) {
    return { ok: false, error: '发布 Topic 不能含通配符或控制字符，UTF-8 长度不能超过 65535 字节' };
  }
  if (typeof mqtt?.publish !== 'function') {
    return { ok: false, error: 'MQTT 发布能力不可用' };
  }

  try {
    const result = await mqtt.publish(
      connection.id,
      normalizedTopic,
      payload,
      qos,
      retain,
    );
    if (result?.ok !== true) {
      return { ok: false, error: result?.error || '发布失败' };
    }
    return { ok: true, result, topic: normalizedTopic };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
