
const fetch = require('node-fetch');

async function testChat(numMessages: number) {
    const messages = [];
    for (let i = 0; i < numMessages; i++) {
        messages.push({ role: 'user', content: 'This is a test message to fill up the context window. ' + i });
        messages.push({ role: 'assistant', content: 'This is a test response to fill up the context window. ' + i });
    }
    messages.push({ role: 'user', content: 'Tell me a long story about a cat.' });

    console.log(`Testing with ${messages.length} messages...`);
    const start = Date.now();

    try {
        const response = await fetch('http://localhost:3000/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: messages,
                context: {
                    module: 'Dashboard',
                    moduleDescription: 'Testing',
                    pathname: '/',
                },
                stream: false
            })
        });

        const duration = Date.now() - start;
        console.log(`Status: ${response.status} ${response.statusText}`);
        console.log(`Duration: ${duration}ms`);

        if (!response.ok) {
            const text = await response.text();
            console.error('Error body:', text);
        } else {
            const data = await response.json();
            console.log('Success. Response length:', data.message.content.length);
        }
    } catch (error) {
        console.error('Fetch failed:', error.message);
    }
    console.log('-----------------------------------');
}

async function run() {
    // Test small
    await testChat(2);
    // Test medium
    await testChat(10);
    // Test large
    await testChat(50);
}

run();
