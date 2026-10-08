import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { useEncatch, type EventCallback, type EventType } from '@encatch/react-native-sdk';

import { resolveAppNavigateRoute } from '@/navigation/resolveAppNavigateRoute';

/**
 * Subscribes to Encatch.on('form:ctaTriggered') and maps schema route strings to
 * Expo Router paths. The SDK closes the form overlay after emitting the event.
 */
export function CtaNavigationHandler() {
  const { on, off } = useEncatch();
  const router = useRouter();

  useEffect(() => {
    const handler: EventCallback = (eventType: EventType, payload) => {
      if (eventType !== 'form:ctaTriggered') return;

      const data = payload.data;
      if (!data) return;

      const action = data.action as string | undefined;
      if (action !== 'app_navigate') return;

      const schemaRoute = data.route as string | undefined;
      const resolvedPath = resolveAppNavigateRoute(schemaRoute);

      if (resolvedPath) {
        console.log(`[CtaNavigation] app_navigate: "${schemaRoute}" → ${resolvedPath}`);
        router.push(resolvedPath as '/billing');
      } else {
        console.log(
          `[CtaNavigation] app_navigate: unknown route "${schemaRoute}" → /route-not-found`
        );
        router.push({
          pathname: '/route-not-found',
          params: { route: schemaRoute ?? '' },
        });
      }
    };

    on(handler);
    return () => off(handler);
  }, [on, off, router]);

  return null;
}
