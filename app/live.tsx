import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Modal, useTVEventHandler, HWEvent, Text, Platform, ToastAndroid } from "react-native";
import * as IntentLauncher from "expo-intent-launcher";
import { liveDebug } from "@/utils/LiveDebug";
import LivePlayer from "@/components/LivePlayer";
import { fetchAndParseM3u, getPlayableUrl, isUltraHighDef, Channel } from "@/services/m3u";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";

export default function LiveScreen() {
  const { m3uUrl, blockUltraHD, externalLivePlayer, dlnaCastMode, dlnaDeviceUrl } = useSettingsStore();
  
  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const [channels, setChannels] = useState<Channel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, Channel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const selectedChannel = channels[currentChannelIndex];
  const selectedChannelUrl = selectedChannel ? getPlayableUrl(selectedChannel.url) : null;

  // 调试：设备信息与当前设置快照（Release APK 通过 adb logcat -s ReactNativeJS 查看）
  // 注意：react-native-tvos 没有 Device 模块，只能安全访问 Platform
  useEffect(() => {
    liveDebug(
      `[LIVE] androidAPI=${Platform.Version} ${JSON.stringify(Platform.constants ?? {})} ` +
      `m3uUrl=${m3uUrl} blockUltraHD=${blockUltraHD} externalLivePlayer=${externalLivePlayer} ` +
      `dlnaCastMode=${dlnaCastMode} dlnaDeviceUrl=${dlnaDeviceUrl}`
    );
  }, [m3uUrl, blockUltraHD, externalLivePlayer, dlnaCastMode, dlnaDeviceUrl]);

  // 外部播放器模式：把直播流交给系统/第三方播放器（走原生硬解路径），
  // 老盒子（Android 5.1）上 ExoPlayer 解码 4K 流易卡死，外部播放更稳定
  useEffect(() => {
    if (!externalLivePlayer || dlnaCastMode || Platform.OS !== "android" || !selectedChannelUrl) return;
    liveDebug(`[LIVE] launching external player: ${selectedChannelUrl}`);
    IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: selectedChannelUrl,
      type: "video/*",
    }).then(() => {
      liveDebug("[LIVE] external player launched OK");
    }).catch((error) => {
      liveDebug(`[LIVE] external player FAILED: ${error?.message || error}`);
      ToastAndroid.show("未找到可播放该流的外部播放器，请安装 MX Player / VLC 等支持网络 HLS 的播放器", ToastAndroid.LONG);
    });
  }, [externalLivePlayer, dlnaCastMode, selectedChannelUrl]);

  useEffect(() => {
    const loadChannels = async () => {
      if (!m3uUrl) return;
      setIsLoading(true);
      liveDebug(`[LIVE] loading m3u: ${m3uUrl}`);
      let parsedChannels = await fetchAndParseM3u(m3uUrl);
      liveDebug(`[LIVE] parsed channels total=${parsedChannels.length}`);
      // 兼容模式：屏蔽 4K/8K 超高清源，避免老电视盒子解码能力不足导致卡死/死机
      if (blockUltraHD) {
        const blocked = parsedChannels.filter((c) => isUltraHighDef(c));
        parsedChannels = parsedChannels.filter((c) => !isUltraHighDef(c));
        liveDebug(
          `[LIVE] blockUltraHD ON, blocked=${blocked.length}, remaining=${parsedChannels.length}, ` +
          `blockedNames=[${blocked.map((c) => c.name).join(" | ")}]`
        );
      } else {
        const ultra = parsedChannels.filter((c) => isUltraHighDef(c));
        liveDebug(`[LIVE] blockUltraHD OFF, ${ultra.length} ultra-HD channels are PLAYABLE in-app: [${ultra.map((c) => c.name).join(" | ")}]`);
      }
      setChannels(parsedChannels);

      const groups: Record<string, Channel[]> = parsedChannels.reduce((acc, channel) => {
        const groupName = channel.group || "Other";
        if (!acc[groupName]) {
          acc[groupName] = [];
        }
        acc[groupName].push(channel);
        return acc;
      }, {} as Record<string, Channel[]>);

      const groupNames = Object.keys(groups);
      setGroupedChannels(groups);
      setChannelGroups(groupNames);
      setSelectedGroup(groupNames[0] || "");

      if (parsedChannels.length > 0) {
        showChannelTitle(parsedChannels[0].name);
      }
      setIsLoading(false);
    };
    loadChannels();
  }, [m3uUrl, blockUltraHD]);

  const showChannelTitle = (title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  };

  const handleSelectChannel = (channel: Channel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    liveDebug(`[LIVE] select channel "${channel.name}" url=${channel.url} index=${globalIndex}`);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
    }
  };

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      if (channels.length === 0) return;
      let newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % channels.length
          : (currentChannelIndex - 1 + channels.length) % channels.length;
      setCurrentChannelIndex(newIndex);
      liveDebug(`[LIVE] ${direction} channel "${channels[newIndex].name}" url=${channels[newIndex].url}`);
      showChannelTitle(channels[newIndex].name);
    },
    [channels, currentChannelIndex]
  );

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== 'tv') return;
      if (isChannelListVisible) return;
      if (event.eventType === "down") setIsChannelListVisible(true);
      else if (event.eventType === "left") changeChannel("prev");
      else if (event.eventType === "right") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType]
  );

  useTVEventHandler(deviceType === 'tv' ? handleTVEvent : () => {});

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderLiveContent = () => (
    <>
      <LivePlayer 
        streamUrl={selectedChannelUrl} 
        channelTitle={channelTitle} 
        useExternal={externalLivePlayer}
        compatMode={blockUltraHD}
        dlnaMode={dlnaCastMode}
        dlnaDeviceUrl={dlnaDeviceUrl}
        onPlaybackStatusUpdate={() => {}} 
      />
      <Modal
        animationType="slide"
        transparent={true}
        visible={isChannelListVisible}
        onRequestClose={() => setIsChannelListVisible(false)}
      >
        <View style={dynamicStyles.modalContainer}>
          <View style={dynamicStyles.modalContent}>
            <Text style={dynamicStyles.modalTitle}>选择频道</Text>
            <View style={dynamicStyles.listContainer}>
              <View style={dynamicStyles.groupColumn}>
                <FlatList
                  data={channelGroups}
                  keyExtractor={(item, index) => `group-${item}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item}
                      onPress={() => setSelectedGroup(item)}
                      isSelected={selectedGroup === item}
                      style={dynamicStyles.groupButton}
                      textStyle={dynamicStyles.groupButtonText}
                    />
                  )}
                />
              </View>
              <View style={dynamicStyles.channelColumn}>
                {isLoading ? (
                  <ActivityIndicator size="large" />
                ) : (
                  <FlatList
                    data={groupedChannels[selectedGroup] || []}
                    keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                    renderItem={({ item }) => (
                      <StyledButton
                        text={item.name || "Unknown Channel"}
                        onPress={() => handleSelectChannel(item)}
                        isSelected={channels[currentChannelIndex]?.id === item.id}
                        hasTVPreferredFocus={channels[currentChannelIndex]?.id === item.id}
                        style={dynamicStyles.channelItem}
                        textStyle={dynamicStyles.channelItemText}
                      />
                    )}
                  />
                )}
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderLiveContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const isTablet = deviceType === 'tablet';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    modalContainer: {
      flex: 1,
      flexDirection: "row",
      justifyContent: isMobile ? "center" : "flex-end",
      backgroundColor: "transparent",
    },
    modalContent: {
      width: isMobile ? '90%' : isTablet ? 400 : 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      padding: spacing,
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    listContainer: {
      flex: 1,
      flexDirection: isMobile ? "column" : "row",
    },
    groupColumn: {
      flex: isMobile ? 0 : 1,
      marginRight: isMobile ? 0 : spacing / 2,
      marginBottom: isMobile ? spacing : 0,
      maxHeight: isMobile ? 120 : undefined,
    },
    channelColumn: {
      flex: isMobile ? 1 : 2,
    },
    groupButton: {
      paddingVertical: isMobile ? minTouchTarget / 4 : 8,
      paddingHorizontal: spacing / 2,
      marginVertical: isMobile ? 2 : 4,
      minHeight: isMobile ? minTouchTarget * 0.7 : undefined,
    },
    groupButtonText: {
      fontSize: isMobile ? 14 : 13,
    },
    channelItem: {
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing,
      marginVertical: isMobile ? 2 : 3,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    channelItemText: {
      fontSize: isMobile ? 14 : 12,
    },
  });
};
