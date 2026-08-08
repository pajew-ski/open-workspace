import { AppShell } from '@/components/layout';
import { FullPageAssistant } from './FullPageAssistant';

export const dynamic = 'force-dynamic';

export default function AssistantPage() {
    return (
        <AppShell title="Assistent" fluid={true}>
            <FullPageAssistant />
        </AppShell>
    );
}
