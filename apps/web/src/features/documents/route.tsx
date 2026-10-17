import type { ScreenRoute } from '@/features/shell/registry';
import { DocumentsContainer } from './DocumentsContainer';

/** The Documents tab (05 s3.10, 09 s5.11), registered with the shell; its row detail uses the shell's slot. */
export const routes: ScreenRoute[] = [{ tab: 'documents', Component: DocumentsContainer, rowDetail: true }];
