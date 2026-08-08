// services/calendarService.js
'use strict';

const { google } = require('googleapis');

/**
 * Initializes an authenticated Google Calendar client for a specific clinic.
 * It pulls the clinic's specific OAuth tokens from their Firebase tenant profile.
 */
function getCalendarClient(clinicCalendarConfig) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );

    // Set the specific clinic's refresh token
    oauth2Client.setCredentials({
        refresh_token: clinicCalendarConfig.tokens.refresh_token
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Checks real-time availability for a specific date.
 */
async function checkAvailability(clinicCalendarConfig, dateISO) {
    try {
        const calendar = getCalendarClient(clinicCalendarConfig);
        const calendarId = clinicCalendarConfig.calendarId || 'primary';

        const endOfDay = new Date(dateISO);
        endOfDay.setHours(23, 59, 59, 999);

        // Fetch all busy slots for the day
        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: new Date(dateISO).toISOString(),
                timeMax: endOfDay.toISOString(),
                items: [{ id: calendarId }]
            }
        });

        return response.data.calendars[calendarId].busy;
    } catch (error) {
        console.error("Calendar Sync Error:", error);
        throw new Error("Could not fetch calendar availability.");
    }
}

module.exports = { checkAvailability };
