import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import whaleGirl from './whalegirl.png'

/** WhaleGirl Bot sidebar mark (internal fan build; upstream mark replaced). */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img src={whaleGirl} alt="" width={size} height={size} style={{ borderRadius: 8, objectFit: 'cover' }} />
}

/** WhaleGirl Bot wordmark. */
export function OfficialBrandName() {
  void BrandWordmark
  void FishLogo
  return <span style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>WhaleGirl Bot</span>
}
