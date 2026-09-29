/**
 * DLNA 自投屏设置：模式开关 + 可选手填 DMR 描述 URL + 局域网设备搜索。
 * 开关与选中设备均即时 saveSettings 持久化（参照兼容模式的做法）。
 */
import React, { useState, useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import { View, TextInput, StyleSheet, Animated, Platform, Pressable, Switch, ActivityIndicator } from "react-native";
import { useTVEventHandler } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { StyledButton } from "@/components/StyledButton";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { liveDebug } from "@/utils/LiveDebug";
import { discoverRenderers, resolveRenderer, setCachedRenderer, DlnaRendererInfo } from "@/services/dlna";

interface DlnaCastSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export interface DlnaCastSectionRef {
  setInputValue: (value: string) => void;
}

export const DlnaCastSection = forwardRef<DlnaCastSectionRef, DlnaCastSectionProps>(
  ({ onChanged, onFocus, onBlur }, ref) => {
    const { dlnaCastMode, setDlnaCastMode, dlnaDeviceUrl, setDlnaDeviceUrl } = useSettingsStore();
    const [isSectionFocused, setIsSectionFocused] = useState(false);
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [isToggleFocused, setIsToggleFocused] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [devices, setDevices] = useState<DlnaRendererInfo[]>([]);
    const inputRef = useRef<TextInput>(null);
    const toggleAnimationStyle = useButtonAnimation(isToggleFocused, 1.2);
    const deviceType = useResponsiveLayout().deviceType;

    const handleToggle = useCallback(() => {
      const next = !useSettingsStore.getState().dlnaCastMode;
      setDlnaCastMode(next);
      onChanged();
      // 开关立即持久化，避免用户忘记点"保存设置"导致重启后失效
      void useSettingsStore.getState().saveSettings();
      liveDebug(`[DLNA-CAST] settings: dlnaCastMode toggled -> ${next}`);
    }, [onChanged, setDlnaCastMode]);

    const handleUrlChange = (url: string) => {
      setDlnaDeviceUrl(url);
      onChanged();
    };

    const handleSelectDevice = (info: DlnaRendererInfo) => {
      setDlnaDeviceUrl(info.location);
      setCachedRenderer(info);
      onChanged();
      void useSettingsStore.getState().saveSettings();
      liveDebug(`[DLNA-CAST] settings: device selected ${info.friendlyName} ${info.location}`);
    };

    const handleSearch = useCallback(async () => {
      if (isSearching) return;
      setIsSearching(true);
      setSearchError(null);
      setDevices([]);
      try {
        const found = await discoverRenderers(5000);
        if (found.length === 0) {
          setSearchError("未发现 DLNA 设备：请确认电视投屏功能已开启且与本机在同一局域网");
        } else {
          setDevices(found);
          // 只有一台时直接选定，省去遥控器逐项操作
          if (found.length === 1) handleSelectDevice(found[0]);
        }
      } catch (e: any) {
        setSearchError(`搜索失败：${e?.message || e}`);
      } finally {
        setIsSearching(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSearching]);

    useImperativeHandle(ref, () => ({
      setInputValue: (value: string) => {
        setDlnaDeviceUrl(value);
        onChanged();
      },
    }));

    useTVEventHandler(
      useCallback(
        (event: any) => {
          if (event.eventType !== "select") return;
          if (isToggleFocused) {
            handleToggle();
          } else if (isSectionFocused) {
            // 整节聚焦时：回车先搜索设备；有结果后回车搜索下一次
            void handleSearch();
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [isToggleFocused, isSectionFocused, handleToggle, handleSearch]
      )
    );

    return (
      <View>
        <SettingsSection
          focusable
          onFocus={() => setIsToggleFocused(true)}
          onBlur={() => setIsToggleFocused(false)}
          onPress={Platform.isTV || deviceType !== "tv" ? undefined : handleToggle}
        >
          <Pressable
            style={styles.row}
            onFocus={() => setIsToggleFocused(true)}
            onBlur={() => setIsToggleFocused(false)}
          >
            <View style={styles.rowInfo}>
              <ThemedText style={styles.sectionTitle}>DLNA 自投屏模式</ThemedText>
              <ThemedText style={styles.subtitle}>
                开启后直播/点播通过 UPnP 推给电视原生渲染器（爱投屏）解码，完整支持 4K，
                绕开老盒子播放器死机问题。电视无响应时请先用下方"搜索设备"或手填电视 DLNA 地址
              </ThemedText>
            </View>
            <Animated.View style={toggleAnimationStyle}>
              <Switch
                value={dlnaCastMode}
                onValueChange={() => { }}
                trackColor={{ false: "#767577", true: Colors.dark.primary }}
                thumbColor={dlnaCastMode ? "#ffffff" : "#f4f3f4"}
                pointerEvents="none"
              />
            </Animated.View>
          </Pressable>
        </SettingsSection>

        <SettingsSection
          focusable
          onFocus={() => {
            setIsSectionFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setIsSectionFocused(false);
            onBlur?.();
          }}
          onPress={Platform.isTV || deviceType !== "tv" ? undefined : () => inputRef.current?.focus()}
        >
          <View style={styles.inputContainer}>
            <ThemedText style={styles.sectionTitle}>投屏设备地址（可选）</ThemedText>
            <ThemedText style={styles.subtitle}>
              电视 DLNA 描述 URL，如 http://192.168.10.170:1330/ ；留空则自动搜索局域网设备
            </ThemedText>
            <TextInput
              ref={inputRef}
              style={[styles.input, isInputFocused && styles.inputFocused]}
              value={dlnaDeviceUrl}
              onChangeText={handleUrlChange}
              placeholder="http://IP:PORT/ 或 desc.xml 地址"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
            />
            <View style={styles.searchRow}>
              <StyledButton
                text={isSearching ? "搜索中..." : "搜索 DLNA 设备"}
                onPress={() => void handleSearch()}
                disabled={isSearching}
                style={styles.searchButton}
              />
              {isSearching && <ActivityIndicator size="small" color="#fff" style={styles.searchSpinner} />}
            </View>
            {!!searchError && <ThemedText style={styles.errorText}>{searchError}</ThemedText>}
            {devices.map((d, i) => (
              <StyledButton
                key={`${d.location}-${i}`}
                text={`${d.friendlyName}${d.location === dlnaDeviceUrl ? "（已选中）" : ""}`}
                onPress={() => handleSelectDevice(d)}
                isSelected={d.location === dlnaDeviceUrl}
                hasTVPreferredFocus={i === 0}
                style={styles.deviceButton}
                textStyle={styles.deviceButtonText}
              />
            ))}
          </View>
        </SettingsSection>
      </View>
    );
  }
);

DlnaCastSection.displayName = "DlnaCastSection";

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowInfo: {
    flex: 1,
    marginRight: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 12,
    color: "#888",
    fontStyle: "italic",
    marginBottom: 8,
    lineHeight: 17,
  },
  inputContainer: {
    width: "100%",
  },
  input: {
    height: 50,
    borderWidth: 2,
    borderRadius: 8,
    paddingHorizontal: 15,
    fontSize: 16,
    backgroundColor: "#3a3a3c",
    color: "white",
    borderColor: "transparent",
    marginBottom: 12,
  },
  inputFocused: {
    borderColor: Colors.dark.primary,
    shadowColor: Colors.dark.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    elevation: 5,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  searchButton: {
    alignSelf: "flex-start",
  },
  searchSpinner: {
    marginLeft: 12,
  },
  errorText: {
    color: "#f88",
    fontSize: 12,
    marginTop: 8,
  },
  deviceButton: {
    marginTop: 8,
  },
  deviceButtonText: {
    fontSize: 13,
  },
});
