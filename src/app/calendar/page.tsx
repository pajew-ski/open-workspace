'use client';

import { useState, useEffect } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, isToday, startOfWeek, endOfWeek, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { AppShell } from '@/components/layout';
import { Button, Card, CardContent } from '@/components/ui';
import styles from './page.module.css';

interface CalendarEvent {
    id: string;
    providerId: string;
    title: string;
    startDate: string;
    endDate: string;
    allDay: boolean;
    color?: string; // Enriched on frontend
}

interface CalendarProvider {
    id: string;
    name: string;
    color: string;
}

type ViewMode = 'month' | 'week' | 'day';

export default function CalendarPage() {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [viewMode, setViewMode] = useState<ViewMode>('month');
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [providers, setProviders] = useState<CalendarProvider[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchProviders();
    }, []);

    useEffect(() => {
        fetchEvents();
    }, [currentDate, viewMode, providers]); // Re-fetch when context changes

    const fetchProviders = async () => {
        try {
            const res = await fetch('/api/calendar');
            const data = await res.json();
            setProviders(data.providers || []);
        } catch (e) {
            console.error(e);
        }
    };

    const fetchEvents = async () => {
        setIsLoading(true);
        try {
            let start, end;
            if (viewMode === 'month') {
                start = startOfMonth(currentDate);
                end = endOfMonth(currentDate);
            } else if (viewMode === 'week') {
                start = startOfWeek(currentDate, { locale: de });
                end = endOfWeek(currentDate, { locale: de });
            } else {
                start = currentDate;
                end = currentDate;
            }

            // Add buffer for events spanning boundaries
            // Fetching slightly wider range is safer
            const bufferStart = new Date(start); bufferStart.setDate(bufferStart.getDate() - 7);
            const bufferEnd = new Date(end); bufferEnd.setDate(bufferEnd.getDate() + 7);

            const res = await fetch(`/api/calendar?action=events&start=${bufferStart.toISOString()}&end=${bufferEnd.toISOString()}`);
            const data = await res.json();

            // Enrich with provider colors
            const enrichedEvents = (data.events || []).map((ev: CalendarEvent) => {
                const provider = providers.find(p => p.id === ev.providerId);
                return { ...ev, color: provider?.color || '#ccc' };
            });

            setEvents(enrichedEvents);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handlePrev = () => {
        if (viewMode === 'month') setCurrentDate(subMonths(currentDate, 1));
        else if (viewMode === 'week') setCurrentDate(subWeeks(currentDate, 1));
        else setCurrentDate(subDays(currentDate, 1));
    };

    const handleNext = () => {
        if (viewMode === 'month') setCurrentDate(addMonths(currentDate, 1));
        else if (viewMode === 'week') setCurrentDate(addWeeks(currentDate, 1));
        else setCurrentDate(addDays(currentDate, 1));
    };

    const handleToday = () => setCurrentDate(new Date());

    const renderMonthView = () => {
        const monthStart = startOfMonth(currentDate);
        const monthEnd = endOfMonth(currentDate);
        const startDate = startOfWeek(monthStart, { locale: de });
        const endDate = endOfWeek(monthEnd, { locale: de });
        const days = eachDayOfInterval({ start: startDate, end: endDate });

        const weekDays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

        return (
            <div className={styles.monthGrid}>
                {weekDays.map(day => <div key={day} className={styles.weekDayHeader}>{day}</div>)}
                {days.map(day => {
                    const dayEvents = events.filter(e => isSameDay(new Date(e.startDate), day));
                    return (
                        <div key={day.toISOString()} className={`${styles.dayCell} ${!isSameMonth(day, monthStart) ? styles.dimmed : ''} ${isToday(day) ? styles.today : ''}`}>
                            <div className={styles.dayNumber}>{format(day, 'd')}</div>
                            <div className={styles.dayEvents}>
                                {dayEvents.slice(0, 4).map(ev => (
                                    <div key={ev.id} className={styles.eventChip} style={{ backgroundColor: ev.color }} title={ev.title}>
                                        {ev.title}
                                    </div>
                                ))}
                                {dayEvents.length > 4 && <div className={styles.moreEvents}>+{dayEvents.length - 4} mehr</div>}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    const renderWeekView = () => {
        const start = startOfWeek(currentDate, { locale: de });
        const weekDays = Array.from({ length: 7 }, (_, i) => addDays(start, i));

        return (
            <div className={styles.weekGrid}>
                <div className={styles.timeColumn}>
                    {Array.from({ length: 24 }).map((_, i) => (
                        <div key={i} className={styles.timeSlot}>{i}:00</div>
                    ))}
                </div>
                {weekDays.map(day => {
                    const dayEvents = events.filter(e => isSameDay(new Date(e.startDate), day));
                    return (
                        <div key={day.toISOString()} className={`${styles.dayColumn} ${isToday(day) ? styles.todayColumn : ''}`}>
                            <div className={styles.dayHeader}>
                                <span className={styles.dayName}>{format(day, 'EEE', { locale: de })}</span>
                                <span className={styles.dayNum}>{format(day, 'd. MMM')}</span>
                            </div>
                            <div className={styles.dayContent}>
                                {dayEvents.map(ev => {
                                    const start = new Date(ev.startDate);
                                    const top = (start.getHours() * 60 + start.getMinutes()) / 1440 * 100;
                                    return (
                                        <div key={ev.id} className={styles.weekEvent} style={{ top: `${top}%`, backgroundColor: ev.color }} title={`${ev.title} (${format(start, 'HH:mm')})`}>
                                            {format(start, 'HH:mm')} {ev.title}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <AppShell title="Kalender">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div className={styles.navigation}>
                        <Button variant="ghost" onClick={handlePrev}>←</Button>
                        <Button variant="ghost" onClick={handleToday}>Heute</Button>
                        <Button variant="ghost" onClick={handleNext}>→</Button>
                        <h2 className={styles.currentDate}>
                            {format(currentDate, viewMode === 'day' ? 'd. MMMM yyyy' : 'MMMM yyyy', { locale: de })}
                        </h2>
                    </div>
                    <div className={styles.viewToggle}>
                        <Button variant={viewMode === 'month' ? 'primary' : 'ghost'} onClick={() => setViewMode('month')}>Monat</Button>
                        <Button variant={viewMode === 'week' ? 'primary' : 'ghost'} onClick={() => setViewMode('week')}>Woche</Button>
                        <Button variant={viewMode === 'day' ? 'primary' : 'ghost'} onClick={() => setViewMode('day')}>Tag</Button>
                    </div>
                </div>

                <Card className={styles.calendarCard}>
                    <CardContent className={styles.calendarContent}>
                        {isLoading && <div className={styles.loadingOverlay}>Laden...</div>}
                        {viewMode === 'month' && renderMonthView()}
                        {viewMode === 'week' && renderWeekView()}
                        {viewMode === 'day' && <div className={styles.placeholder}>Tagesansicht folgt in Kürze</div>}
                    </CardContent>
                </Card>
            </div>
        </AppShell>
    );
}
