import React, { useRef, useState, useEffect } from "react";
import { View, StyleSheet, Text, ActivityIndicator } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";
import { liveDebug } from "@/utils/LiveDebug";

interface LivePlayerProps {
  streamUrl: string | null;
  channelTitle?: string | null;
  useExternal?: boolean;
  onPlaybackStatusUpdate: (status: AVPlaybackStatus) => void;
}

const PLAYBACK_TIMEOUT = 15000; // 15 seconds

export default function LivePlayer({ streamUrl, channelTitle, useExternal, onPlaybackStatusUpdate }: LivePlayerProps) {
  const video = useRef<Video>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTimeout, setIsTimeout] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStateRef = useRef<string>("");
  useKeepAwake();

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (streamUrl) {
      liveDebug(`[LivePlayer] start loading uri=${streamUrl}`);
      setIsLoading(true);
      setIsTimeout(false);
      lastStateRef.current = "loading";
      timeoutRef.current = setTimeout(() => {
        liveDebug(`[LivePlayer] TIMEOUT after ${PLAYBACK_TIMEOUT}ms uri=${streamUrl}`);
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
  }, [streamUrl]);

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
        liveDebug(`[LivePlayer] PLAYBACK ERROR: ${JSON.stringify(status.error)} uri=${streamUrl}`);
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

  if (useExternal) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>正在通过外部播放器播放{channelTitle ? `：${channelTitle}` : ""}</Text>
        <Text style={styles.messageText}>若无播放器弹出，说明本机没有可处理 video/* 的播放应用，请安装第三方播放器或关闭外部播放选项</Text>
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
          uri: streamUrl,
        }}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay
        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
        onError={(e) => {
          liveDebug(`[LivePlayer] Video onError: ${JSON.stringify(e)} uri=${streamUrl}`);
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
