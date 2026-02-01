import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { A2UIRenderer } from './A2UIRenderer'
import { A2UINode } from './types'

// Mock CSS imports
vi.mock('./components/Display.css', () => ({}))
vi.mock('./components/Structure.css', () => ({}))
vi.mock('./components/Status.css', () => ({}))
vi.mock('./components/Input.css', () => ({}))

describe('A2UIRenderer', () => {
    let onAction: ReturnType<typeof vi.fn>

    beforeEach(() => {
        onAction = vi.fn()
    })

    describe('Basic Display Components', () => {
        it('renders Text component', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Text: { text: 'Hello World' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Hello World')).toBeInTheDocument()
        })

        it('renders Text with literalString format', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Text: { text: { literalString: 'Literal Text' } } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Literal Text')).toBeInTheDocument()
        })

        it('renders Card with title', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Card: { title: 'Karte Titel' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByRole('heading', { name: 'Karte Titel' })).toBeInTheDocument()
        })

        it('renders Divider', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Divider: {} }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByRole('separator')).toBeInTheDocument()
        })
    })

    describe('Layout Components', () => {
        it('renders Column with children', () => {
            const nodes: A2UINode[] = [
                { id: 'col', component: { Column: { gap: '16px', children: { explicitList: ['child1'] } } } },
                { id: 'child1', component: { Text: { text: 'Child in Column' } } }
            ]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Child in Column')).toBeInTheDocument()
        })

        it('renders Row with children', () => {
            const nodes: A2UINode[] = [
                { id: 'row', component: { Row: { gap: '8px', children: { explicitList: ['child1'] } } } },
                { id: 'child1', component: { Text: { text: 'Child in Row' } } }
            ]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Child in Row')).toBeInTheDocument()
        })
    })

    describe('Interaction Components', () => {
        it('renders Button and handles click', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Button: { label: 'Klick mich', onPress: { actionId: 'test-action' } } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)

            const button = screen.getByRole('button', { name: 'Klick mich' })
            expect(button).toBeInTheDocument()

            fireEvent.click(button)
            expect(onAction).toHaveBeenCalledWith('test-action')
        })

        it('renders Button with literalString label', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Button: { label: { literalString: 'Literal Button' } } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByRole('button', { name: 'Literal Button' })).toBeInTheDocument()
        })
    })

    describe('Display Components', () => {
        it('renders Markdown (fallback)', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Markdown: { content: '# Markdown Heading' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            // While loading, shows raw content
            expect(screen.getByText('# Markdown Heading')).toBeInTheDocument()
        })

        it('renders CodeBlock with language', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { CodeBlock: { code: 'console.log("test")', language: 'javascript' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('console.log("test")')).toBeInTheDocument()
            expect(screen.getByText('javascript')).toBeInTheDocument()
        })

        it('renders Link component', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Link: { text: 'Link Text', href: 'https://example.com' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            const link = screen.getByRole('link', { name: 'Link Text' })
            expect(link).toHaveAttribute('href', 'https://example.com')
        })

        it('renders Alert with variants', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Alert: { variant: 'warning', title: 'Warnung', message: 'Dies ist wichtig' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Warnung')).toBeInTheDocument()
            expect(screen.getByText('Dies ist wichtig')).toBeInTheDocument()
        })
    })

    describe('Structure Components', () => {
        it('renders List with items', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { List: { items: ['Item 1', 'Item 2', 'Item 3'] } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Item 1')).toBeInTheDocument()
            expect(screen.getByText('Item 2')).toBeInTheDocument()
            expect(screen.getByText('Item 3')).toBeInTheDocument()
        })

        it('renders ordered List', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { List: { ordered: true, items: ['Schritt 1', 'Schritt 2'] } }
            }]
            const { container } = render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(container.querySelector('ol')).toBeInTheDocument()
        })

        it('renders Table with columns and rows', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: {
                    Table: {
                        columns: ['Name', 'Alter'],
                        rows: [['Max', '25'], ['Anna', '30']]
                    }
                }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByRole('table')).toBeInTheDocument()
            expect(screen.getByText('Name')).toBeInTheDocument()
            expect(screen.getByText('Max')).toBeInTheDocument()
            expect(screen.getByText('30')).toBeInTheDocument()
        })
    })

    describe('Status Components', () => {
        it('renders Progress bar', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Progress: { value: 50, max: 100, label: 'Fortschritt' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Fortschritt')).toBeInTheDocument()
            expect(screen.getByText('50%')).toBeInTheDocument()
        })

        it('renders Chip', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Chip: { label: 'Tag Label', variant: 'primary' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Tag Label')).toBeInTheDocument()
        })

        it('renders Badge with count', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Badge: { count: 5, inline: true } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('5')).toBeInTheDocument()
        })
    })

    describe('Input Components', () => {
        it('renders Input field', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Input: { label: 'Name', placeholder: 'Dein Name' } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Name')).toBeInTheDocument()
            expect(screen.getByPlaceholderText('Dein Name')).toBeInTheDocument()
        })

        it('Input triggers onChange action', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Input: { label: 'Email', placeholder: 'email@example.com', onChange: { actionId: 'email-change' } } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)

            const input = screen.getByPlaceholderText('email@example.com')
            fireEvent.change(input, { target: { value: 'test@example.com' } })
            expect(onAction).toHaveBeenCalledWith('email-change', { value: 'test@example.com' })
        })

        it('renders Select with options', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: {
                    Select: {
                        label: 'Land',
                        options: ['Deutschland', 'Oesterreich', 'Schweiz']
                    }
                }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByText('Land')).toBeInTheDocument()
            expect(screen.getByRole('combobox')).toBeInTheDocument()
            expect(screen.getByRole('option', { name: 'Deutschland' })).toBeInTheDocument()
        })

        it('renders Checkbox', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Checkbox: { label: 'Ich akzeptiere', checked: false } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(screen.getByLabelText('Ich akzeptiere')).toBeInTheDocument()
        })

        it('Checkbox triggers onChange action', () => {
            const nodes: A2UINode[] = [{
                id: '1',
                component: { Checkbox: { label: 'Aktivieren', onChange: { actionId: 'toggle' } } }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)

            const checkbox = screen.getByLabelText('Aktivieren')
            fireEvent.click(checkbox)
            expect(onAction).toHaveBeenCalledWith('toggle', { checked: true })
        })
    })

    describe('Edge Cases', () => {
        it('returns null for empty components array', () => {
            const { container } = render(<A2UIRenderer components={[]} onAction={onAction} />)
            expect(container.firstChild).toBeNull()
        })

        it('shows warning for unknown component', () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { })
            const nodes: A2UINode[] = [{
                id: '1',
                component: { UnknownComponent: {} }
            }]
            render(<A2UIRenderer components={nodes} onAction={onAction} />)
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Unknown component UnknownComponent'),
                expect.anything()
            )
            consoleSpy.mockRestore()
        })
    })
})
