import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { ComponentProps } from 'react';

type ConfigProviderMotion = NonNullable<
  ComponentProps<typeof ConfigProvider>['motion']
>;

/**
 * The `motion` factory handed to `@lobehub/ui`'s `ConfigProvider`.
 *
 * The library declares this prop against its own `motion` major — 5.x pins
 * `motion@^12` and installs a copy of its own — while the app ships
 * `motion@13`. Both describe the same runtime shape, which is why the
 * end-to-end suite is green with the two copies loaded, but their
 * `FeaturePackages` types come from different files and do not meet: passing
 * ours straight through fails the build with "union type too complex to
 * represent".
 *
 * Narrowed once here, so every provider and every test that mounts one shares
 * this adapter instead of carrying its own cast.
 */
export const configProviderMotion = motion as unknown as ConfigProviderMotion;
