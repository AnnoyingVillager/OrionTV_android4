import React, { useState, useRef, useImperativeHandle, forwardRef } from "react";
import { View, TextInput, StyleSheet, Animated, Platform, Pressable, Switch } from "react-native";
import { useTVEventHandler } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { useButtonAnimation } from "@/hooks/useAnimation";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface LiveStreamSectionProps {
  onChanged: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPress?: () => void;
}

export interface LiveStreamSectionRef {
  setInputValue: (value: string) => void;
}

export const LiveStreamSection = forwardRef<LiveStreamSectionRef, LiveStreamSectionProps>(
  ({ onChanged, onFocus, onBlur, onPress }, ref) => {
    const { m3uUrl, setM3uUrl, remoteInputEnabled, blockUltraHD, setBlockUltraHD, externalLivePlayer, setExternalLivePlayer } = useSettingsStore();
    const { serverUrl } = useRemoteControlStore();
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [isSectionFocused, setIsSectionFocused] = useState(false);
    const [isCompatFocused, setIsCompatFocused] = useState(false);
    const [isExternalFocused, setIsExternalFocused] = useState(false);
    const inputRef = useRef<TextInput>(null);
    const inputAnimationStyle = useButtonAnimation(isSectionFocused, 1.01);
    const compatAnimationStyle = useButtonAnimation(isCompatFocused, 1.2);
    const externalAnimationStyle = useButtonAnimation(isExternalFocused, 1.2);
    const deviceType = useResponsiveLayout().deviceType;

    const handleCompatToggle = () => {
      setBlockUltraHD(!blockUltraHD);
      onChanged();
      // 开关立即持久化，避免用户忘记点"保存设置"导致重启后失效
      void useSettingsStore.getState().saveSettings();
    };

    const handleExternalToggle = () => {
      setExternalLivePlayer(!externalLivePlayer);
      onChanged();
      // 开关立即持久化，避免用户忘记点"保存设置"导致重启后失效
      void useSettingsStore.getState().saveSettings();
    };

    const handleUrlChange = (url: string) => {
      setM3uUrl(url);
      onChanged();
    };

    useImperativeHandle(ref, () => ({
      setInputValue: (value: string) => {
        setM3uUrl(value);
        onChanged();
      },
    }));

    const handleSectionFocus = () => {
      setIsSectionFocused(true);
      onFocus?.();
    };

    const handleSectionBlur = () => {
      setIsSectionFocused(false);
      onBlur?.();
    };

    const handlePress = () => {
      inputRef.current?.focus();
      onPress?.();
    }

    const handleTVEvent = React.useCallback(
      (event: any) => {
        if (isCompatFocused && event.eventType === "select") {
          handleCompatToggle();
          return;
        }
        if (isExternalFocused && event.eventType === "select") {
          handleExternalToggle();
          return;
        }
        if (isSectionFocused && event.eventType === "select") {
          inputRef.current?.focus();
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [isSectionFocused, isCompatFocused, isExternalFocused, blockUltraHD, externalLivePlayer]
    );

    useTVEventHandler(handleTVEvent);


        const [selection, setSelection] = useState<{ start: number; end: number }>({
          start: 0,
          end: 0,
        });
        // 当用户手动移动光标或选中文本时，同步到 state（可选）
        const onSelectionChange = ({
          nativeEvent: { selection },
        }: any) => {
          setSelection(selection);
        };

    return (
      <View>
      <SettingsSection focusable onFocus={handleSectionFocus} onBlur={handleSectionBlur}
        onPress={Platform.isTV || deviceType !== 'tv' ? undefined : handlePress}
      >
        <View style={styles.inputContainer}>
          <View style={styles.titleContainer}>
            <ThemedText style={styles.sectionTitle}>直播源地址</ThemedText>
            {remoteInputEnabled && serverUrl && (
              <ThemedText style={styles.subtitle}>用手机访问 {serverUrl}，可远程输入</ThemedText>
            )}
          </View>
          <Animated.View style={inputAnimationStyle}>
            <TextInput
              ref={inputRef}
              style={[styles.input, isInputFocused && styles.inputFocused]}
              value={m3uUrl}
              onChangeText={handleUrlChange}
              placeholder="输入 M3U 直播源地址"
              placeholderTextColor="#888"
              autoCapitalize="none"
              autoCorrect={false}
              onFocus={() => {
                setIsInputFocused(true);
                // 将光标移动到文本末尾
                const end = m3uUrl.length;
                setSelection({ start: end, end: end });
                // 有时需要延迟一下，让系统先完成 focus 再设置 selection
                //（在 Android 上更可靠）
                setTimeout(() => {
                  // 对于受控的 selection 已经生效，这里仅作保险
                  inputRef.current?.setNativeProps({ selection: { start: end, end: end } });
                }, 0);
              }}
              selection={selection}
              onSelectionChange={onSelectionChange} // 可选

              onBlur={() => setIsInputFocused(false)}
            // onPress={handlePress}
            />
          </Animated.View>
        </View>
      </SettingsSection>
      <SettingsSection
        focusable
        onFocus={() => setIsCompatFocused(true)}
        onBlur={() => setIsCompatFocused(false)}
        onPress={Platform.isTV || deviceType !== 'tv' ? undefined : handleCompatToggle}
      >
        <Pressable
          style={styles.compatRow}
          onFocus={() => setIsCompatFocused(true)}
          onBlur={() => setIsCompatFocused(false)}
        >
          <View style={styles.compatInfo}>
            <ThemedText style={styles.sectionTitle}>兼容模式：屏蔽 4K/8K 源</ThemedText>
            <ThemedText style={styles.subtitle}>
              老电视盒子（如 Android 5）硬件解码能力有限，播放 4K 直播源可能导致卡死或死机，建议开启
            </ThemedText>
          </View>
          <Animated.View style={compatAnimationStyle}>
            <Switch
              value={blockUltraHD}
              onValueChange={() => { }} // 禁用 Switch 直接交互，由按键/遥控器事件触发
              trackColor={{ false: "#767577", true: Colors.dark.primary }}
              thumbColor={blockUltraHD ? "#ffffff" : "#f4f3f4"}
              pointerEvents="none"
            />
          </Animated.View>
        </Pressable>
      </SettingsSection>
      <SettingsSection
        focusable
        onFocus={() => setIsExternalFocused(true)}
        onBlur={() => setIsExternalFocused(false)}
        onPress={Platform.isTV || deviceType !== 'tv' ? undefined : handleExternalToggle}
      >
        <Pressable
          style={styles.compatRow}
          onFocus={() => setIsExternalFocused(true)}
          onBlur={() => setIsExternalFocused(false)}
        >
          <View style={styles.compatInfo}>
            <ThemedText style={styles.sectionTitle}>使用外部播放器播放直播</ThemedText>
            <ThemedText style={styles.subtitle}>
              将直播流交给系统/第三方播放器（如 MX Player、爱投屏）走原生硬解播放，适合 App 内播放 4K 卡死的老盒子
            </ThemedText>
          </View>
          <Animated.View style={externalAnimationStyle}>
            <Switch
              value={externalLivePlayer}
              onValueChange={() => { }} // 禁用 Switch 直接交互，由按键/遥控器事件触发
              trackColor={{ false: "#767577", true: Colors.dark.primary }}
              thumbColor={externalLivePlayer ? "#ffffff" : "#f4f3f4"}
              pointerEvents="none"
            />
          </Animated.View>
        </Pressable>
      </SettingsSection>
      </View>
    );
  }
);

LiveStreamSection.displayName = "LiveStreamSection";

const styles = StyleSheet.create({
  compatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  compatInfo: {
    flex: 1,
    marginRight: 12,
  },
  titleContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginRight: 12,
  },
  subtitle: {
    fontSize: 12,
    color: "#888",
    fontStyle: "italic",
  },
  inputContainer: {
    marginBottom: 12,
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
  },
  inputFocused: {
    borderColor: Colors.dark.primary,
    shadowColor: Colors.dark.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 10,
    elevation: 5,
  },
});
