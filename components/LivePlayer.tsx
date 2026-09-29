import React, { useRef, useState, useEffect } from "react";
import { View, StyleSheet, Text, ActivityIndicator } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";
import { liveDebug } from "@/utils/LiveDebug";
import { selectBestVariant } from "@/services/m3u";
import DlnaCastPlayer from "@/components/DlnaCastPlayer";

interface LivePlayerProps {
  streamUrl: string | null;
  channelTitle?: string | null;
  useExternal?: boolean;
  compatMode?: boolean;
  dlnaMode?: boolean;
  dlnaDeviceUrl?: string;
  onPlaybackStatusUpdate: (status: AVPlaybackStatus) => void;
}

const PLAYBACK_TIMEOUT = 15000; // 15 seconds
// 老设备解码安全上限：1080p（兼容模式下先探测 HLS 分辨率再播放）
const SAFE_MAX_WIDTH = 1920;
const SAFE_MAX_HEIGHT = 1080;

export default function LivePlayer({ streamUrl, channelTitle, useExternal, compatMode, dlnaMode, dlnaDeviceUrl, onPlaybackStatusUpdate }: LivePlayerProps) {
  const video = useRef<Video>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTimeout, setIsTimeout] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [compatSkipReason, setCompatSkipReason] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStateRef = useRef<string>("");
  useKeepAwake();

  // 兼容模式：播放前拉取 m3u8，解析 HLS 变体分辨率。
  // 超规格流直接喂给老设备解码器会导致驱动崩溃甚至整机死机，
  // 这里自动降到 ≤1080p 的最高变体；若全部超限则拒绝播放该频道。
  useEffect(() => {
    let cancelled = false;
    setCompatSkipReason(null);
    if (!streamUrl) {
      setResolvedUrl(null);
      return;
    }
    if (!compatMode || dlnaMode) {
      // DLNA 投屏模式走电视原生管线，支持 4K，无需本机探测降档
      setResolvedUrl(streamUrl);
      return;
    }
    setResolvedUrl(null);
    setIsAnalyzing(true);
    (async () => {
      try {
        liveDebug(`[LivePlayer] compat probe fetch ${streamUrl}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(streamUrl, { signal: controller.signal });
        clearTimeout(timer);
        const text = await resp.text();
        if (cancelled) return;
        const pick = selectBestVariant(text, streamUrl, SAFE_MAX_WIDTH, SAFE_MAX_HEIGHT);
        if (pick.action === "play" && pick.url) {
          liveDebug(`[LivePlayer] compat: downgraded to variant ${pick.url}`);
          setResolvedUrl(pick.url);
        } else if (pick.action === "skip") {
          liveDebug(`[LivePlayer] compat: SKIP channel - ${pick.reason}`);
          setCompatSkipReason(pick.reason || "超高清流超出设备解码能力");
        } else {
          liveDebug("[LivePlayer] compat: not a master playlist, play directly");
          setResolvedUrl(streamUrl);
        }
      } catch (error) {
        if (cancelled) return;
        liveDebug(`[LivePlayer] compat probe FAILED (${error}), fallback to direct play`);
        setResolvedUrl(streamUrl);
      } finally {
        if (!cancelled) setIsAnalyzing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streamUrl, compatMode, dlnaMode]);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (resolvedUrl) {
      liveDebug(`[LivePlayer] start loading uri=${resolvedUrl}`);
      setIsLoading(true);
      setIsTimeout(false);
      lastStateRef.current = "loading";
      timeoutRef.current = setTimeout(() => {
        liveDebug(`[LivePlayer] TIMEOUT after ${PLAYBACK_TIMEOUT}ms uri=${resolvedUrl}`);
        setIsTimeout(true);
        setIsLoading(false);
      }, PLAYBACK_TIMEOUT);
    } else {
      setIsLoading(false);
      setIsTimeout(false);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [resolvedUrl]);

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    // 状态跃迁日志（去抖，只在状态变化时输出，避免刷屏）
    let stateKey: string;
    if (status.isLoaded) {
      stateKey = status.isPlaying ? "playing" : status.isBuffering ? "buffering" : "paused";
    } else {
      stateKey = "error";
    }
    if (stateKey !== lastStateRef.current) {
      lastStateRef.current = stateKey;
      if (status.isLoaded) {
        liveDebug(
          `[LivePlayer] state -> ${stateKey} (loaded, position=${Math.round(status.positionMillis / 1000)}s, ` +
          `duration=${Math.round((status.durationMillis ?? -1) / 1000)}s)`
        );
      } else if (status.error) {
        liveDebug(`[LivePlayer] PLAYBACK ERROR: ${JSON.stringify(status.error)} uri=${resolvedUrl}`);
      }
    }
    if (status.isLoaded) {
      if (status.isPlaying) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        setIsLoading(false);
        setIsTimeout(false);
      } else if (status.isBuffering) {
        setIsLoading(true);
      }
    } else {
      if (status.error) {
        setIsLoading(false);
        setIsTimeout(true);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      }
    }
    onPlaybackStatusUpdate(status);
  };

  if (!streamUrl) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按向下键选择频道</Text>
      </View>
    );
  }

  if (dlnaMode) {
    // 自投屏：不渲染 expo-av Video，把流推给电视 DMR 原生解码
    return (
      <DlnaCastPlayer
        streamUrl={streamUrl}
        channelTitle={channelTitle}
        deviceUrl={dlnaDeviceUrl}
      />
    );
  }

  if (useExternal) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>正在通过外部播放器播放{channelTitle ? `：${channelTitle}` : ""}</Text>
        <Text style={styles.messageText}>若无播放器弹出，说明本机没有可处理 video/* 的播放应用，请安装第三方播放器或关闭外部播放选项</Text>
      </View>
    );
  }

  if (compatSkipReason) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>{channelTitle ?? "该频道"}：超出设备解码能力，已跳过</Text>
        <Text style={styles.messageText}>{compatSkipReason}</Text>
        <Text style={styles.messageText}>按左右键切换其它频道</Text>
      </View>
    );
  }

  if (isAnalyzing) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.messageText}>正在检测频道分辨率...</Text>
      </View>
    );
  }

  if (!resolvedUrl) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按向下键选择频道</Text>
      </View>
    );
  }

  if (isTimeout) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>加载失败，请重试</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Video
        ref={video}
        style={styles.video}
        source={{
          uri: resolvedUrl,
        }}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay
        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
        onError={(e) => {
          liveDebug(`[LivePlayer] Video onError: ${JSON.stringify(e)} uri=${resolvedUrl}`);
          setIsTimeout(true);
          setIsLoading(false);
        }}
      />
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>加载中...</Text>
        </View>
      )}
      {channelTitle && !isLoading && !isTimeout && (
        <View style={styles.overlay}>
          <Text style={styles.title}>{channelTitle}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
    alignSelf: "stretch",
  },
  overlay: {
    position: "absolute",
    top: 20,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    padding: 10,
    borderRadius: 5,
  },
  title: {
    color: "#fff",
    fontSize: 18,
  },
  messageText: {
    color: "#fff",
    fontSize: 16,
    marginTop: 10,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
});
