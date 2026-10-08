import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  Pressable,
  Dimensions,
  type ListRenderItem,
} from 'react-native';
import { SymbolView } from 'expo-symbols';

import type { FormConfig } from '@/types/formConfig';

export interface BlockedFormItem {
  id: string;
  formTitle: string;
  formConfig: FormConfig;
}

interface InterceptorCarouselProps {
  items: BlockedFormItem[];
  onRemove: (id: string) => void;
  onItemPress?: (item: BlockedFormItem) => void;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
const CAROUSEL_VIEWPORT_WIDTH = SCREEN_WIDTH * 0.7;
const CARD_WIDTH = CAROUSEL_VIEWPORT_WIDTH - 16;
const CARD_MARGIN = 8;
const CARD_HEIGHT = 48;

export function InterceptorCarousel({ items, onRemove, onItemPress }: InterceptorCarouselProps) {
  const flatListRef = useRef<FlatList>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const itemWidth = CARD_WIDTH + CARD_MARGIN * 2;

  useEffect(() => {
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, items.length - 1)));
  }, [items.length]);

  const onScrollEnd = (e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const offset = e.nativeEvent.contentOffset.x;
    const index = Math.round(offset / itemWidth);
    setCurrentIndex(Math.min(Math.max(0, index), items.length - 1));
  };

  const scrollToIndex = (index: number) => {
    flatListRef.current?.scrollToOffset({
      offset: index * itemWidth,
      animated: true,
    });
    setCurrentIndex(index);
  };

  const getItemLayout = (_: unknown, index: number) => ({
    length: itemWidth,
    offset: index * itemWidth,
    index,
  });

  const renderItem: ListRenderItem<BlockedFormItem> = ({ item }) => (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => onItemPress?.(item)}
      disabled={!onItemPress}>
      <View style={styles.iconContainer}>
        <SymbolView
          name={{ ios: 'doc.text', android: 'description', web: 'description' }}
          tintColor="#6366f1"
          size={20}
        />
      </View>
      <Text style={styles.formTitle} numberOfLines={1}>
        {item.formTitle}
      </Text>
      <Pressable
        style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
        onPress={(e) => {
          e.stopPropagation();
          onRemove(item.id);
        }}
        hitSlop={8}>
        <SymbolView
          name={{ ios: 'xmark.circle.fill', android: 'close', web: 'close' }}
          tintColor="#94a3b8"
          size={18}
        />
      </Pressable>
    </Pressable>
  );

  if (items.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={[styles.carouselViewport, { width: CAROUSEL_VIEWPORT_WIDTH }]}>
        <FlatList
          ref={flatListRef}
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          snapToInterval={itemWidth}
          getItemLayout={getItemLayout}
          snapToAlignment="center"
          decelerationRate="fast"
          contentContainerStyle={styles.listContent}
          onMomentumScrollEnd={onScrollEnd}
        />
      </View>
      {items.length > 1 && (
        <View style={styles.dots}>
          {items.map((_, index) => (
            <Pressable
              key={index}
              style={[styles.dot, index === currentIndex && styles.dotActive]}
              onPress={() => scrollToIndex(index)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 100,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  carouselViewport: {
    overflow: 'hidden',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  listContent: {
    paddingHorizontal: 8,
  },
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    marginHorizontal: CARD_MARGIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(30, 41, 59, 0.95)',
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  cardPressed: {
    opacity: 0.9,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  formTitle: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '500',
  },
  closeButton: {
    padding: 4,
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(148, 163, 184, 0.5)',
  },
  dotActive: {
    backgroundColor: '#6366f1',
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
