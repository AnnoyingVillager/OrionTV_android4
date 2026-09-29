import Logger from '@/utils/Logger';

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
    const response = await fetch(m3uUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    const m3uText = await response.text();
    return parseM3U(m3uText);
  } catch (error) {
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
