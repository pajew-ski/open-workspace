'use client';

import { useTheme } from '@/components/providers';
import { Button } from '@/components/ui';
import styles from './page.module.css';

export function ThemeSelector() {
    const { theme, setTheme } = useTheme();

    return (
        <div className={styles.themeButtons}>
            <Button
                variant={theme === 'light' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTheme('light')}
            >
                Hell
            </Button>
            <Button
                variant={theme === 'dark' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTheme('dark')}
            >
                Dunkel
            </Button>
            <Button
                variant={theme === 'system' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setTheme('system')}
            >
                System
            </Button>
        </div>
    );
}
