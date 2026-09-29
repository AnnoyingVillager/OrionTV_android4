import Logger from '@/utils/Logger';
import { liveDebug } from '@/utils/LiveDebug';

const logger = Logger.withTag('M3U');

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
}

export const parseM3U = (m3uText: string): Channel[] => {
  const parsedChannels: Channel[] = [];
  const lines = m3uText.split('\n');
  let currentChannelInfo: Partial<Channel> | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('#EXTINF:')) {
      currentChannelInfo = {}; // Start a new channel
      const commaIndex = trimmedLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        currentChannelInfo.name = trimmedLine.substring(commaIndex + 1).trim();
        const attributesPart = trimmedLine.substring(8, commaIndex);
        const logoMatch = attributesPart.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch && logoMatch[1]) {
          currentChannelInfo.logo = logoMatch[1];
        }
        const groupMatch = attributesPart.match(/group-title="([^"]*)"/i);
        if (groupMatch && groupMatch[1]) {
          currentChannelInfo.group = groupMatch[1];
        }
      } else {
        currentChannelInfo.name = trimmedLine.substring(8).trim();
      }
    } else if (currentChannelInfo && trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('://')) {
      currentChannelInfo.url = trimmedLine;
      currentChannelInfo.id = currentChannelInfo.url; // Use URL as ID
      
      // Ensure all required fields are present, providing defaults if necessary
      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || 'Unknown',
        logo: currentChannelInfo.logo || '',
        group: currentChannelInfo.group || 'Default',
      };
      
      parsedChannels.push(finalChannel);
      currentChannelInfo = null; // Reset for the next channel
    }
  }
  return parsedChannels;
};

// 识别 4K/8K 超高清直播源：用于老设备（如 Android 5 电视盒子）兼容模式过滤。
// 老盒子硬件解码器普遍只支持 1080p H.264，强行解码 4K 流会导致媒体服务崩溃甚至整机死机。
// 注意国内 IPTV 频道常用中文标注（如"CCTV16 超高清"），需一并匹配。
const ULTRA_HD_PATTERN = /4k|8k|2160|uhd|超高清/i;

export const isUltraHighDef = (channel: Pick<Channel, "name" | "url">): boolean => {
  return ULTRA_HD_PATTERN.test(channel.name || "") || ULTRA_HD_PATTERN.test(channel.url || "");
};

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  try {
    liveDebug(`[M3U] fetching ${m3uUrl}`);
    const response = await fetch(m3uUrl);
    liveDebug(`[M3U] fetch status=${response.status} ${response.ok ? 'OK' : 'NOT OK'}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    const m3uText = await response.text();
    liveDebug(`[M3U] body length=${m3uText.length}, startsWithBOM=${m3uText.charCodeAt(0) === 0xFEFF}, hasEXTINF=${m3uText.includes('#EXTINF')}`);
    const channels = parseM3U(m3uText);
    liveDebug(`[M3U] parsed ${channels.length} channels`);
    return channels;
  } catch (error) {
    liveDebug(`[M3U] fetch/parse FAILED: ${error}`);
    logger.info("Error fetching or parsing M3U:", error);
    return []; // Return empty array on error
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  // In React Native, we use the proxy for all http streams to avoid potential issues.
  // if (originalUrl.toLowerCase().startsWith('http://')) {
  //   // Use the baseURL from the existing api instance.
  //   if (!api.baseURL) {
  //       console.warn("API base URL is not set. Cannot create proxy URL.")
  //       return originalUrl; // Fallback to original URL
  //   }
  //   return `${api.baseURL}/proxy?url=${encodeURIComponent(originalUrl)}`;
  // }
  // HTTPS streams can be played directly.
  return originalUrl;
};

// --- HLS 分辨率探测（兼容模式） ---
// 老设备（如海思 Hi3751V551，H.265 硬解上限 4K@30、H.264 上限 1080p）被喂入超规格流
// 会导致解码驱动崩溃甚至整机死机。频道名不带 4K 标识时按名过滤会漏网，
// 因此播放前先拉取 master playlist 解析 RESOLUTION，选择设备能承载的最高变体；
// 若所有变体都超限则拒绝播放，而不是把超规格流交给硬件解码器。
export interface VariantPick {
  action: "play" | "skip" | "direct";
  url?: string;
  reason?: string;
}

interface HlsVariant {
  url: string;
  width?: number;
  height?: number;
  bandwidth: number;
}

const joinUrl = (base: string, href: string): string => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return href;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    const baseDir = base.substring(0, base.lastIndexOf("/") + 1);
    if (href.startsWith("/")) {
      const m = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i);
      return `${m ? m[1] : ""}${href}`;
    }
    return `${baseDir}${href}`;
  }
};

export const parseMasterVariants = (masterText: string, masterUrl: string): HlsVariant[] => {
  const lines = masterText.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.toUpperCase().startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }
    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
    const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    // 变体 URI 是紧跟其后的第一行非注释内容
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (candidate && !candidate.startsWith("#")) {
        uri = candidate;
        i = j;
        break;
      }
    }
    if (!uri) {
      continue;
    }
    variants.push({
      url: joinUrl(masterUrl, uri),
      width: resolutionMatch ? parseInt(resolutionMatch[1], 10) : undefined,
      height: resolutionMatch ? parseInt(resolutionMatch[2], 10) : undefined,
      bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0,
    });
  }
  return variants;
};

export const selectBestVariant = (masterText: string, masterUrl: string, maxWidth: number, maxHeight: number): VariantPick => {
  const variants = parseMasterVariants(masterText, masterUrl);
  if (variants.length === 0) {
    // 不是 master playlist（媒体分片列表或解析失败），交给播放器直连
    return { action: "direct" };
  }
  const usable = variants.filter(
    (v) =>
      v.width === undefined ||
      v.height === undefined ||
      (v.width <= maxWidth && v.height <= maxHeight)
  );
  if (usable.length === 0) {
    const desc = variants.map((v) => `${v.width}x${v.height}@${Math.round(v.bandwidth / 1000)}kbps`).join(", ");
    return {
      action: "skip",
      reason: `所有分片均超出设备解码能力: [${desc}]`,
    };
  }
  usable.sort((a, b) => b.bandwidth - a.bandwidth);
  return { action: "play", url: usable[0].url };
};
