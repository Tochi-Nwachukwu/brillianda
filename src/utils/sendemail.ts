import sgMail from '@sendgrid/mail';

// Set API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY as string);
// sgMail.setDataResidency('eu'); 
// uncomment the above line if you are sending mail using a regional EU subuser

interface EmailOptions {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    from?: string;
}

async function sendEmail(options: EmailOptions): Promise<void> {
    const { to, subject, text, html, from } = options;

    const msg = {
        to,
        from: from || (process.env.SENDGRID_FROM_EMAIL as string),
        subject,
        text,
        html,
    };

    try {
        await sgMail.send(msg as any);
        console.log('Email sent successfully to:', to);
    } catch (error: any) {
        console.error('Error sending email:', error);
        if (error.response) {
            console.error('SendGrid error details:', error.response.body);
        }
        throw error; // Re-throw so calling code can handle it
    }
}

export default sendEmail;