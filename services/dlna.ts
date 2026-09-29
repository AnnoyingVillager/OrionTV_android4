/**
 * DLNA / UPnP AV 自投屏服务（纯 JS 实现，无原生依赖）
 *
 * 原理：老电视（Hi3751V551）Android 侧 MediaCodec 播 4K@50 会驱动崩溃死机，
 * 但电视原生管线（爱投屏 DMR 渲染器）完整支持 4K@50。
 * 这里通过 SSDP 发现局域网内 MediaRenderer，用 SOAP SetAVTransportURI + Play
 * 把流 URL 推给电视 DMR，让电视原生解码，App 只做遥控器。
 *
 * 全程 [DLNA-CAST] 前缀日志，adb logcat -s ReactNativeJS 可见。
 */
import TcpSocket from "react-native-tcp-socket";
import { liveDebug } from "@/utils/LiveDebug";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const MR_TARGET = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AVTRANSPORT_SERVICE_TYPE = "urn:schemas-upnp-org:service:AVTransport:1";

export interface DlnaRendererInfo {
  /** 设备可读名，如 "客厅电视Q3A_BD7-DLNA" */
  friendlyName: string;
  /** 设备描述文档 URL（SSDP LOCATION 或用户手填） */
  location: string;
  /** AVTransport 服务 Control 端点（绝对 URL） */
  controlUrl: string;
}

// ---------------------------------------------------------------------------
// 模块级设备缓存：换台/重复推流时跳过 SSDP 发现，秒开
// ---------------------------------------------------------------------------
let cachedRenderer: DlnaRendererInfo | null = null;

export const getCachedRenderer = (): DlnaRendererInfo | null => cachedRenderer;
export const setCachedRenderer = (info: DlnaRendererInfo | null): void => {
  cachedRenderer = info;
  if (info) {
    liveDebug(`[DLNA-CAST] renderer cached: ${info.friendlyName} -> ${info.controlUrl}`);
  }
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** 根据 URL 猜测 MIME，用于 DIDL protocolInfo。DMR 通常宽容，未知用通配 */
export const guessMime = (url: string): string => {
  const path = url.split("?")[0].toLowerCase();
  if (path.includes(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".ts") || path.endsWith(".mpegts") || path.endsWith(".vob")) return "video/mp2t";
  if (path.endsWith(".mkv")) return "video/x-matroska";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".avi")) return "video/x-msvideo";
  return "*/*";
};

// ---------------------------------------------------------------------------
// 设备描述 XML 解析（避免引入 DOMParser 依赖，正则提取即可）
// ---------------------------------------------------------------------------
const parseRendererDescription = (descriptionUrl: string, xml: string): DlnaRendererInfo => {
  const nameMatch = /<friendlyName>([^<]*)<\/friendlyName>/i.exec(xml);
  const friendlyName = nameMatch ? nameMatch[1].trim() : "";

  // 在含 AVTransport serviceId 的 <service> 块里找 controlURL
  const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  let controlPath = "";
  for (const block of serviceBlocks) {
    if (block.includes("AVTransport")) {
      const cu = /<controlURL>([^<]*)<\/controlURL>/i.exec(block);
      if (cu && cu[1].trim()) {
        controlPath = cu[1].trim();
        break;
      }
    }
  }
  if (!controlPath) {
    throw new Error(`设备描述中没有 AVTransport 服务: ${descriptionUrl}`);
  }

  // 相对 controlURL 按描述 URL join（兼容 ../、/ 开头、以及极少数绝对 URL）
  const controlUrl = /^https?:/i.test(controlPath)
    ? controlPath
    : new URL(controlPath, descriptionUrl).toString();

  return {
    friendlyName: friendlyName || "DLNA Device",
    location: descriptionUrl,
    controlUrl,
  };
};

const fetchWithTimeout = async (url: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 由设备描述 URL 解析出可控制的渲染器信息。
 * 兼容用户手填 http://IP:PORT/ 根路径的情况（多数 DMR 根路径即返回 desc.xml）。
 */
export const resolveRenderer = async (descriptionUrl: string): Promise<DlnaRendererInfo> => {
  const trimmed = descriptionUrl.trim();
  liveDebug(`[DLNA-CAST] fetching device description: ${trimmed}`);
  const resp = await fetchWithTimeout(trimmed, {
    headers: { Accept: "text/xml, application/xml, */*" },
  });
  const xml = await resp.text();
  if (!xml || (!xml.includes("root") && !xml.includes("device"))) {
    throw new Error(`描述 URL 未返回 UPnP XML（HTTP ${resp.status}）: ${trimmed}`);
  }
  const info = parseRendererDescription(trimmed, xml);
  liveDebug(`[DLNA-CAST] resolved renderer: ${info.friendlyName} control=${info.controlUrl}`);
  return info;
};

// ---------------------------------------------------------------------------
// SSDP M-SEARCH 发现
// ---------------------------------------------------------------------------
export const discoverRenderers = async (timeoutMs = 5000): Promise<DlnaRendererInfo[]> => {
  liveDebug(`[DLNA-CAST] SSDP M-SEARCH start (ST=${MR_TARGET}), listening ${timeoutMs}ms`);
  const locations = new Set<string>();
  let socket: any = null;

  try {
    socket = TcpSocket.createUdpSocket();
  } catch (e) {
    liveDebug(`[DLNA-CAST] create UDP socket FAILED: ${e}`);
    return [];
  }

  socket.on("message", (data: any) => {
    try {
      const text: string = typeof data === "string" ? data : data.toString();
      const m = /LOCATION:\s*(\S+)/i.exec(text);
      if (m && /^https?:/i.test(m[1]) && !locations.has(m[1])) {
        locations.add(m[1]);
        liveDebug(`[DLNA-CAST] SSDP response LOCATION=${m[1]}`);
      }
    } catch (e) {
      liveDebug(`[DLNA-CAST] SSDP message parse error: ${e}`);
    }
  });
  socket.on("error", (err: any) => {
    liveDebug(`[DLNA-CAST] UDP socket error: ${err?.message || err}`);
  });

  try {
    await socket.bind({ address: "0.0.0.0", port: 0 });
    try { await socket.setBroadcast(true); } catch {}
    try { await socket.setMulticastTTL(4); } catch {}
    try { await socket.addMembership(SSDP_ADDR); } catch {}
  } catch (e) {
    liveDebug(`[DLNA-CAST] UDP bind FAILED: ${e}`);
    try { socket.close(); } catch {}
    return [];
  }

  const request = [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 2",
    `ST: ${MR_TARGET}`,
    "",
    "",
  ].join("\r\n");

  const sendSearch = () => {
    socket
      .send({ address: SSDP_ADDR, port: SSDP_PORT, content: request })
      .catch((e: any) => liveDebug(`[DLNA-CAST] SSDP send failed: ${e?.message || e}`));
  };

  sendSearch();
  const interval = setInterval(sendSearch, 1200);

  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  clearInterval(interval);
  try { socket.close(); } catch {}

  // 逐个解析描述文档，筛掉不含 AVTransport 的设备
  const results: DlnaRendererInfo[] = [];
  for (const location of Array.from(locations)) {
    try {
      results.push(await resolveRenderer(location));
    } catch (e) {
      liveDebug(`[DLNA-CAST] skip device ${location}: ${e instanceof Error ? e.message : e}`);
    }
  }
  liveDebug(`[DLNA-CAST] discovery done, MediaRenderers=${results.length}`);
  return results;
};

// ---------------------------------------------------------------------------
// AVTransport SOAP 客户端
// ---------------------------------------------------------------------------
export class DlnaRendererClient {
  readonly info: DlnaRendererInfo;

  constructor(info: DlnaRendererInfo) {
    this.info = info;
  }

  private async soap(action: string, bodyInner: string): Promise<string> {
    const envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${AVTRANSPORT_SERVICE_TYPE}">${bodyInner}</u:${action}></s:Body></s:Envelope>`;

    liveDebug(`[DLNA-CAST] SOAP ${action} -> ${this.info.controlUrl}`);
    const resp = await fetchWithTimeout(
      this.info.controlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPACTION: `"${AVTRANSPORT_SERVICE_TYPE}#${action}"`,
          Connection: "close",
        },
        body: envelope,
      },
      8000
    );
    const text = await resp.text();
    if (!resp.ok || text.includes("Fault") || text.includes("errorDescription")) {
      const detail = text.replace(/\s+/g, " ").substring(0, 300);
      liveDebug(`[DLNA-CAST] SOAP ${action} FAILED HTTP ${resp.status}: ${detail}`);
      throw new Error(`${action} 失败 (HTTP ${resp.status}): ${detail}`);
    }
    liveDebug(`[DLNA-CAST] SOAP ${action} OK (HTTP ${resp.status})`);
    return text;
  }

  /** SetAVTransportURI：把流地址与 DIDL-Lite 元数据推给渲染器 */
  setAVTransportURI(mediaUrl: string, title?: string | null): Promise<string> {
    const mime = guessMime(mediaUrl);
    const didl =
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
      '<item id="0" parentID="-1" restricted="1">' +
      `<dc:title>${escapeXml(title || "OrionTV")}</dc:title>` +
      "<upnp:class>object.item.videoItem</upnp:class>" +
      `<res protocolInfo="http-get:*:${mime}:*">${escapeXml(mediaUrl)}</res>` +
      "</item></DIDL-Lite>";
    // DIDL 整体再转义一次嵌入 SOAP，避免 < > & 破坏信封
    return this.soap(
      "SetAVTransportURI",
      `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(mediaUrl)}</CurrentURI>` +
        `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`
    );
  }

  play(): Promise<string> {
    return this.soap("Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
  }

  stop(): Promise<string> {
    return this.soap("Stop", "<InstanceID>0</InstanceID>");
  }

  /** 一站式推流：SetAVTransportURI + Play（换台即重复调用） */
  async cast(mediaUrl: string, title?: string | null): Promise<void> {
    liveDebug(`[DLNA-CAST] casting "${title || ""}" url=${mediaUrl} -> ${this.info.friendlyName}`);
    await this.setAVTransportURI(mediaUrl, title);
    await this.play();
    liveDebug(`[DLNA-CAST] cast OK: ${mediaUrl}`);
  }
}

// ---------------------------------------------------------------------------
// 高层入口：按优先级取渲染器（设置手填 URL > 模块缓存 > SSDP 自动发现）
// ---------------------------------------------------------------------------
export const getRendererClient = async (manualDeviceUrl?: string): Promise<DlnaRendererClient> => {
  const manual = (manualDeviceUrl || "").trim();
  if (manual) {
    try {
      const info = await resolveRenderer(manual);
      cachedRenderer = info;
      return new DlnaRendererClient(info);
    } catch (e) {
      liveDebug(`[DLNA-CAST] manual device url FAILED (${e}), fallback to cache/discovery`);
    }
  }
  if (cachedRenderer) {
    liveDebug(`[DLNA-CAST] using cached renderer: ${cachedRenderer.friendlyName}`);
    return new DlnaRendererClient(cachedRenderer);
  }
  const found = await discoverRenderers();
  if (found.length === 0) {
    throw new Error("局域网内未发现 DLNA 渲染设备（请确认与 App 同一网络，且电视投屏功能已开启）");
  }
  if (found.length > 1) {
    liveDebug(`[DLNA-CAST] ${found.length} renderers found: [${found.map((f) => f.friendlyName).join(" | ")}], using first`);
  }
  cachedRenderer = found[0];
  return new DlnaRendererClient(found[0]);
};
