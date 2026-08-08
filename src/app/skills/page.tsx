'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenText, Globe, FileText, GitBranch, Plug, Trash2, Eye, Pencil } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import {
    createClientSkill,
    deleteClientSkill,
    listClientSkills,
    updateClientSkill,
    type ClientSkill,
} from '@/lib/skills/store.client';
import { loadSkillFromUrl, loadSkillsFromRepo } from '@/lib/skills/loaders';
import { parseSkillMarkdown } from '@/lib/skills/parse';
import type { SkillSourceType } from '@/lib/skills/types';
import styles from './page.module.css';

/**
 * Skills: instruction packages the assistant can pull on demand
 * (progressive disclosure via the use_skill tool) or that are always
 * injected. Loadable from every channel: manual, URL, GitHub repo
 * (SKILL.md convention) — and from MCP prompts on the tools page.
 */

const SOURCE_META: Record<SkillSourceType, { label: string; icon: React.ReactNode }> = {
    manual: { label: 'Manuell', icon: <FileText size={12} aria-hidden="true" /> },
    url: { label: 'URL', icon: <Globe size={12} aria-hidden="true" /> },
    repo: { label: 'Repo', icon: <GitBranch size={12} aria-hidden="true" /> },
    'mcp-prompt': { label: 'MCP', icon: <Plug size={12} aria-hidden="true" /> },
};

type AddMode = 'manual' | 'url' | 'repo';

export default function SkillsPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [addMode, setAddMode] = useState<AddMode | null>(null);
    const [viewing, setViewing] = useState<ClientSkill | null>(null);
    const [editing, setEditing] = useState<ClientSkill | null>(null);
    const [deleting, setDeleting] = useState<ClientSkill | null>(null);
    const [busy, setBusy] = useState(false);

    // Add form state
    const [formName, setFormName] = useState('');
    const [formDescription, setFormDescription] = useState('');
    const [formContent, setFormContent] = useState('');
    const [formRef, setFormRef] = useState('');

    const { data: skills = [] } = useQuery<ClientSkill[]>({
        queryKey: ['skills'],
        queryFn: listClientSkills,
    });

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['skills'] });

    const resetForm = () => {
        setFormName(''); setFormDescription(''); setFormContent(''); setFormRef('');
    };

    const handleAdd = async () => {
        setBusy(true);
        try {
            if (addMode === 'manual') {
                if (!formContent.trim()) throw new Error('Inhalt fehlt.');
                const parsed = parseSkillMarkdown(formContent, formName || 'Neuer Skill');
                await createClientSkill({
                    name: formName.trim() || parsed.name,
                    description: formDescription.trim() || parsed.description,
                    content: parsed.content,
                    source: { type: 'manual' },
                });
                toast.success('Skill angelegt');
            } else if (addMode === 'url') {
                const loaded = await loadSkillFromUrl(formRef.trim());
                await createClientSkill({
                    name: loaded.name,
                    description: loaded.description,
                    content: loaded.content,
                    source: { type: 'url', ref: loaded.sourceRef },
                });
                toast.success(`Skill „${loaded.name}" geladen`);
            } else if (addMode === 'repo') {
                const loaded = await loadSkillsFromRepo(formRef.trim());
                for (const skill of loaded) {
                    await createClientSkill({
                        name: skill.name,
                        description: skill.description,
                        content: skill.content,
                        source: { type: 'repo', ref: skill.sourceRef },
                    });
                }
                toast.success(`${loaded.length} Skill${loaded.length === 1 ? '' : 's'} aus dem Repo geladen`);
            }
            setAddMode(null);
            resetForm();
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Laden fehlgeschlagen');
        } finally {
            setBusy(false);
        }
    };

    const handleToggle = async (skill: ClientSkill, field: 'enabled' | 'alwaysInject') => {
        try {
            await updateClientSkill(skill, { [field]: !skill[field] });
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Aktualisierung fehlgeschlagen');
        }
    };

    const handleSaveEdit = async () => {
        if (!editing) return;
        setBusy(true);
        try {
            await updateClientSkill(editing, {
                name: formName,
                description: formDescription,
                content: formContent,
            });
            setEditing(null);
            resetForm();
            invalidate();
            toast.success('Skill gespeichert');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
        } finally {
            setBusy(false);
        }
    };

    return (
        <AppShell
            title="Skills"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => setAddMode('manual')}
                    label="Neuer Skill"
                />
            }
        >
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>Skills</h2>
                        <p>
                            Anleitungen, die der Assistent bei passenden Aufgaben lädt (Progressive Disclosure über das{' '}
                            <code>use_skill</code>-Tool). Quellen: manuell, URL, GitHub-Repo (SKILL.md-Konvention) und
                            MCP-Prompts (Import auf der Werkzeuge-Seite).
                        </p>
                    </div>
                    <div className={styles.addButtons}>
                        <Button variant="secondary" size="sm" onClick={() => { resetForm(); setAddMode('url'); }}>
                            <Globe size={14} aria-hidden="true" /> Von URL
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => { resetForm(); setAddMode('repo'); }}>
                            <GitBranch size={14} aria-hidden="true" /> Aus Repo
                        </Button>
                        <Button variant="primary" size="sm" onClick={() => { resetForm(); setAddMode('manual'); }}>
                            + Manuell
                        </Button>
                    </div>
                </div>

                {skills.length === 0 ? (
                    <div className={styles.empty}>
                        <BookOpenText size={40} aria-hidden="true" />
                        <h3>Noch keine Skills</h3>
                        <p>
                            Lade z. B. offene SKILL.md-Sammlungen aus GitHub-Repos oder schreibe eigene Anleitungen —
                            aktivierte Skills stehen dem Assistenten automatisch zur Verfügung.
                        </p>
                        <Button variant="primary" onClick={() => setAddMode('manual')}>Ersten Skill anlegen</Button>
                    </div>
                ) : (
                    <ul className={styles.skillGrid}>
                        {skills.map(skill => {
                            const source = SOURCE_META[skill.source.type] ?? SOURCE_META.manual;
                            return (
                                <li key={`${skill.origin}-${skill.id}`} className={`${styles.skillCard} ${!skill.enabled ? styles.disabled : ''}`}>
                                    <div className={styles.skillHead}>
                                        <strong className={styles.skillName}>{skill.name}</strong>
                                        <span className={styles.sourceTag} title={skill.source.ref || source.label}>
                                            {source.icon} {source.label}
                                        </span>
                                        {skill.origin === 'local' && (
                                            <span className={styles.originTag}>nur dieser Browser</span>
                                        )}
                                    </div>
                                    <p className={styles.skillDescription}>{skill.description || 'Keine Beschreibung.'}</p>
                                    <div className={styles.skillFooter}>
                                        <label className={styles.toggle}>
                                            <input
                                                type="checkbox"
                                                checked={skill.enabled}
                                                onChange={() => handleToggle(skill, 'enabled')}
                                                aria-label={`${skill.name} ${skill.enabled ? 'deaktivieren' : 'aktivieren'}`}
                                            />
                                            <span>Aktiv</span>
                                        </label>
                                        <label className={styles.toggle} title="Inhalt in jeden System-Prompt einbetten (statt bei Bedarf zu laden)">
                                            <input
                                                type="checkbox"
                                                checked={skill.alwaysInject}
                                                onChange={() => handleToggle(skill, 'alwaysInject')}
                                                aria-label={`${skill.name} immer einbetten`}
                                            />
                                            <span>Immer aktiv</span>
                                        </label>
                                        <div className={styles.cardActions}>
                                            <button
                                                type="button"
                                                className={styles.iconAction}
                                                onClick={() => setViewing(skill)}
                                                title="Ansehen"
                                                aria-label={`${skill.name} ansehen`}
                                            >
                                                <Eye size={15} aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.iconAction}
                                                onClick={() => {
                                                    setEditing(skill);
                                                    setFormName(skill.name);
                                                    setFormDescription(skill.description);
                                                    setFormContent(skill.content);
                                                }}
                                                title="Bearbeiten"
                                                aria-label={`${skill.name} bearbeiten`}
                                            >
                                                <Pencil size={15} aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                className={`${styles.iconAction} ${styles.danger}`}
                                                onClick={() => setDeleting(skill)}
                                                title="Löschen"
                                                aria-label={`${skill.name} löschen`}
                                            >
                                                <Trash2 size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {/* Add dialog */}
                {addMode && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Skill hinzufügen">
                        <div className={styles.dialog}>
                            <h3>
                                {addMode === 'manual' && 'Skill schreiben'}
                                {addMode === 'url' && 'Skill von URL laden'}
                                {addMode === 'repo' && 'Skills aus GitHub-Repo laden'}
                            </h3>

                            {addMode === 'manual' && (
                                <>
                                    <label className={styles.field}>
                                        <span>Name</span>
                                        <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="z. B. Release Notes schreiben" />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Beschreibung (wann soll der Assistent den Skill laden?)</span>
                                        <input value={formDescription} onChange={e => setFormDescription(e.target.value)} placeholder="Nutze diesen Skill, wenn …" />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Inhalt (Markdown; YAML-Frontmatter mit name/description wird erkannt)</span>
                                        <textarea
                                            value={formContent}
                                            onChange={e => setFormContent(e.target.value)}
                                            rows={12}
                                            placeholder={'---\nname: Mein Skill\ndescription: Wann dieser Skill gilt\n---\n\n# Anweisungen\n…'}
                                        />
                                    </label>
                                </>
                            )}

                            {addMode === 'url' && (
                                <label className={styles.field}>
                                    <span>URL einer Markdown-/SKILL.md-Datei</span>
                                    <input value={formRef} onChange={e => setFormRef(e.target.value)} type="url" placeholder="https://raw.githubusercontent.com/…/SKILL.md" />
                                </label>
                            )}

                            {addMode === 'repo' && (
                                <label className={styles.field}>
                                    <span>GitHub-Repo (owner/repo, owner/repo/pfad oder github.com-URL)</span>
                                    <input value={formRef} onChange={e => setFormRef(e.target.value)} placeholder="anthropics/skills" />
                                </label>
                            )}

                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => { setAddMode(null); resetForm(); }}>Abbrechen</Button>
                                <Button
                                    variant="primary"
                                    onClick={handleAdd}
                                    disabled={busy || (addMode === 'manual' ? !formContent.trim() : !formRef.trim())}
                                >
                                    {busy ? 'Lade…' : addMode === 'manual' ? 'Anlegen' : 'Laden'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* View dialog */}
                {viewing && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Skill ${viewing.name}`}>
                        <div className={styles.dialog}>
                            <h3>{viewing.name}</h3>
                            <p className={styles.viewDescription}>{viewing.description}</p>
                            <pre className={styles.viewContent}>{viewing.content}</pre>
                            <div className={styles.dialogButtons}>
                                <Button variant="primary" onClick={() => setViewing(null)}>Schließen</Button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Edit dialog */}
                {editing && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Skill ${editing.name} bearbeiten`}>
                        <div className={styles.dialog}>
                            <h3>Skill bearbeiten</h3>
                            <label className={styles.field}>
                                <span>Name</span>
                                <input value={formName} onChange={e => setFormName(e.target.value)} />
                            </label>
                            <label className={styles.field}>
                                <span>Beschreibung</span>
                                <input value={formDescription} onChange={e => setFormDescription(e.target.value)} />
                            </label>
                            <label className={styles.field}>
                                <span>Inhalt</span>
                                <textarea value={formContent} onChange={e => setFormContent(e.target.value)} rows={12} />
                            </label>
                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => { setEditing(null); resetForm(); }}>Abbrechen</Button>
                                <Button variant="primary" onClick={handleSaveEdit} disabled={busy || !formName.trim()}>
                                    {busy ? 'Speichere…' : 'Speichern'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deleting !== null}
                    title="Skill löschen?"
                    message={`Möchtest du „${deleting?.name}" wirklich löschen?`}
                    confirmText="Löschen"
                    cancelText="Abbrechen"
                    variant="danger"
                    onConfirm={async () => {
                        if (!deleting) return;
                        try {
                            await deleteClientSkill(deleting);
                            setDeleting(null);
                            invalidate();
                        } catch (error) {
                            toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
                        }
                    }}
                    onCancel={() => setDeleting(null)}
                />
            </div>
        </AppShell>
    );
}
