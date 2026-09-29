/**
 * DLNA 自投屏播放视图：不渲染 expo-av Video，而是把流 URL 推给电视 DMR，
 * 由电视原生管线解码（4K@50 安全）。App 侧只显示投屏状态与停止/重试操作。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  StyleSheet,
  Text,
  ActivityIndicator,
  BackHandler,
  useTVEventHandler,
} from "react-native";
import { StyledButton } from "@/components/StyledButton";
import { liveDebug } from "@/utils/LiveDebug";
import {
  DlnaRendererClient,
  getRendererClient,
  setCachedRenderer,
} from "@/services/dlna";

interface DlnaCastPlayerProps {
  streamUrl: string | null;
  channelTitle?: string | null;
  /** 设置里手填的 DMR 描述 URL（可选，空则自动 SSDP 发现） */
  deviceUrl?: string;
}

type CastPhase = "starting" | "casting" | "stopped" | "error";

export default function DlnaCastPlayer({ streamUrl, channelTitle, deviceUrl }: DlnaCastPlayerProps) {
  const [phase, setPhase] = useState<CastPhase>("starting");
  const [deviceName, setDeviceName] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const clientRef = useRef<DlnaRendererClient | null>(null);
  // 是否已有流推给 DMR（决定退出时是否需要 Stop）
  const castingRef = useRef(false);
  // 换台竞态令牌：只允许最后一次推流结果落地
  const seqRef = useRef(0);
  // 供 TV 事件回调读取最新值（避免闭包过期）
  const latestRef = useRef<{ phase: CastPhase; url: string | null; title: string | null; deviceUrl?: string }>({
    phase: "starting",
    url: streamUrl,
    title: channelTitle || null,
    deviceUrl,
  });
  latestRef.current = { phase, url: streamUrl, title: channelTitle || null, deviceUrl };

  const doCast = useCallback(async (url: string, title: string | null, manualDeviceUrl?: string) => {
    const seq = ++seqRef.current;
    setPhase("starting");
    setErrorMsg(null);
    try {
      const client = clientRef.current ?? (await getRendererClient(manualDeviceUrl));
      clientRef.current = client;
      setDeviceName(client.info.friendlyName);
      await client.cast(url, title);
      if (seq !== seqRef.current) return; // 已被更新的换台覆盖
      castingRef.current = true;
      setPhase("casting");
      liveDebug(`[DLNA-CAST] view: casting on "${client.info.friendlyName}"`);
    } catch (e: any) {
      if (seq !== seqRef.current) return;
      const msg = e?.message || String(e);
      liveDebug(`[DLNA-CAST] view: cast FAILED: ${msg}`);
      // 缓存设备可能已下线/拒收，作废之，下次重试重新发现
      clientRef.current = null;
      setCachedRenderer(null);
      setErrorMsg(msg);
      setPhase("error");
    }
  }, []);

  // 流地址变化 = 换台：重新 SetAVTransportURI + Play
  useEffect(() => {
    if (!streamUrl) return;
    void doCast(streamUrl, channelTitle || null, deviceUrl);
    // 仅在 streamUrl 变化时重推；title/deviceUrl 变化不触发重新推流
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  const doStop = useCallback(async () => {
    seqRef.current++;
    if (clientRef.current && castingRef.current) {
      try {
        await clientRef.current.stop();
        liveDebug("[DLNA-CAST] view: Stop OK");
      } catch (e) {
        liveDebug(`[DLNA-CAST] view: Stop failed: ${e}`);
      }
      castingRef.current = false;
    }
    setPhase("stopped");
  }, []);

  // 卸载（离开直播页/关闭投屏模式）务必 Stop，防电视继续播
  useEffect(() => {
    return () => {
      seqRef.current++;
      if (clientRef.current && castingRef.current) {
        liveDebug("[DLNA-CAST] view unmount -> Stop");
        castingRef.current = false;
        clientRef.current.stop().catch((e) => liveDebug(`[DLNA-CAST] unmount Stop failed: ${e}`));
      }
    };
  }, []);

  // 按返回键退出时先停（App 被杀时 JS 未必能跑完卸载清理，这里同步补一发）
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const client = clientRef.current;
      if (client && castingRef.current) {
        castingRef.current = false;
        client.stop().catch(() => {});
      }
      return false; // 不拦截，继续正常返回
    });
    return () => sub.remove();
  }, []);

  // TV 遥控器：上键 = 停止/重新投屏（直播页其它键由 live.tsx 处理，互不冲突）
  useTVEventHandler((event) => {
    if (event.eventType !== "up") return;
    const { phase: p, url, title, deviceUrl: dUrl } = latestRef.current;
    if (p === "casting") {
      void doStop();
    } else if ((p === "stopped" || p === "error") && url) {
      void doCast(url, title, dUrl);
    }
  });

  if (phase === "starting") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.messageText}>正在把频道推送到电视 DLNA 播放器（原生解码，支持 4K）...</Text>
        {channelTitle && <Text style={styles.subText}>{channelTitle}</Text>}
      </View>
    );
  }

  if (phase === "casting") {
    return (
      <View style={styles.container}>
        <Text style={styles.bigIcon}>📺</Text>
        <Text style={styles.messageText}>已投屏到「{deviceName}」，请用电视观看</Text>
        {channelTitle && <Text style={styles.subText}>{channelTitle}</Text>}
        <Text style={styles.hintText}>左右键换台 · 上键停止投屏 · 返回键退出（自动停止）</Text>
        <StyledButton text="停止投屏" onPress={() => void doStop()} style={styles.button} />
      </View>
    );
  }

  if (phase === "stopped") {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>投屏已停止</Text>
        <Text style={styles.hintText}>按上键或下方按钮重新投屏当前频道</Text>
        <StyledButton
          text="重新投屏"
          onPress={() => streamUrl && void doCast(streamUrl, channelTitle || null, deviceUrl)}
          style={styles.button}
        />
      </View>
    );
  }

  // error
  return (
    <View style={styles.container}>
      <Text style={styles.messageText}>投屏失败</Text>
      {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
      <Text style={styles.hintText}>
        请确认：1) 电视与本机在同一局域网；2) 电视的投屏/DLNA 功能已开启；
        3) 可在设置中手填电视 DLNA 地址。或关闭"DLNA 自投屏模式"回退本机播放。
      </Text>
      <StyledButton
        text="重试"
        onPress={() => streamUrl && void doCast(streamUrl, channelTitle || null, deviceUrl)}
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    padding: 24,
  },
  bigIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  messageText: {
    color: "#fff",
    fontSize: 18,
    marginTop: 10,
    textAlign: "center",
  },
  subText: {
    color: "#ccc",
    fontSize: 16,
    marginTop: 6,
  },
  hintText: {
    color: "#888",
    fontSize: 13,
    marginTop: 12,
    textAlign: "center",
    lineHeight: 19,
  },
  errorText: {
    color: "#f88",
    fontSize: 13,
    marginTop: 10,
    textAlign: "center",
  },
  button: {
    marginTop: 18,
    paddingHorizontal: 28,
  },
});
