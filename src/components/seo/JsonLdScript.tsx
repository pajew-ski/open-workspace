
import { Thing, WithContext } from 'schema-dts';

interface JsonLdScriptProps {
    data: WithContext<Thing> | null;
}

export function JsonLdScript({ data }: JsonLdScriptProps) {
    if (!data) return null;

    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
        />
    );
}
