// services/paymentService.js
"use strict";

const Razorpay            = require("razorpay");
const crypto              = require("crypto");
const { v4: uuidv4 }      = require("uuid");
const { logger, AppError } = require("../errorHandler");
const { buildPaymentCallbackUrl } = require("../urlHelper");

// Conditionally initialize Razorpay so the app doesn't crash if env vars are missing
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  logger.warn("[Razorpay] Keys missing from environment variables. Payment features are disabled.");
}

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert INR amount to paise (Razorpay requires integer paise).
 * @param {number} inr
 * @returns {number}
 */
function toPaise(inr) {
  return Math.round(inr * 100);
}

/**
 * Normalize a phone number to E.164 for Razorpay.
 * @param {string} phone
 * @returns {string}
 */
function _normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay Order (for standard SDK checkout).
 */
async function createOrder(amount, currency = "INR", receipt = null, notes = {}) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const order = await razorpay.orders.create({
      amount:   toPaise(amount),
      currency,
      receipt:  receipt || `rcpt_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
      notes,
    });
    logger.info(`[Razorpay] Order created: ${order.id} | ₹${amount}`);
    return order;
  } catch (err) {
    logger.error(`[Razorpay] createOrder failed: ${err.message}`);
    throw new AppError(`Razorpay order creation failed: ${err.message}`, 502, "RAZORPAY_ORDER_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT LINKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay Payment Link suitable for sharing via WhatsApp.
 */
async function createPaymentLink({
  amount,
  orderId,
  phone,
  customerName  = "Customer",
  description   = null,
  isCodDeposit  = false,
  expiryMinutes = 15,
}) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const expireBy = Math.floor(Date.now() / 1000) + expiryMinutes * 60;

    const payload = {
      amount:          toPaise(amount),
      currency:        "INR",
      accept_partial:  false,
      description:     description || (isCodDeposit ? "COD Security Deposit — The Dream Pair" : "Order Payment — The Dream Pair"),
      customer: {
        name:    customerName,
        contact: _normalizePhone(phone),
      },
      notify: {
        sms:   true,
        email: false,
      },
      reminder_enable: true,
      callback_url:    buildPaymentCallbackUrl(orderId),
      callback_method: "get",
      expire_by:       expireBy,
      notes: {
        orderId,
        type: isCodDeposit ? "cod_deposit" : "order_payment",
      },
    };

    const link = await razorpay.paymentLink.create(payload);
    logger.info(`[Razorpay] Payment link created: ${link.id} | order=${orderId} | ₹${amount}`);

    return {
      paymentLinkId: link.id,
      shortUrl:      link.short_url,
      amount,
    };
  } catch (err) {
    logger.error(`[Razorpay] createPaymentLink failed: ${err.message}`);
    throw new AppError(`Payment link creation failed: ${err.message}`, 502, "RAZORPAY_LINK_FAILED");
  }
}

/**
 * Fetch a Razorpay Payment Link by its ID.
 */
async function fetchPaymentLink(paymentLinkId) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const link = await razorpay.paymentLink.fetch(paymentLinkId);
    logger.info(`[Razorpay] Payment link fetched: ${paymentLinkId} | status=${link.status}`);
    return link;
  } catch (err) {
    logger.error(`[Razorpay] fetchPaymentLink failed: ${err.message}`);
    throw new AppError(`Failed to fetch payment link: ${err.message}`, 502, "RAZORPAY_FETCH_LINK_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the full details of a payment by its Razorpay payment ID.
 */
async function fetchPaymentDetails(paymentId) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const payment = await razorpay.payments.fetch(paymentId);
    logger.info(`[Razorpay] Payment fetched: ${paymentId} | status=${payment.status}`);
    return payment;
  } catch (err) {
    logger.error(`[Razorpay] fetchPaymentDetails failed: ${err.message}`);
    throw new AppError(`Failed to fetch payment: ${err.message}`, 502, "RAZORPAY_FETCH_PAYMENT_FAILED");
  }
}

/**
 * Manually capture an authorized payment (use only if auto-capture is disabled).
 */
async function capturePayment(paymentId, amount) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const captured = await razorpay.payments.capture(paymentId, toPaise(amount), "INR");
    logger.info(`[Razorpay] Payment captured: ${paymentId} | ₹${amount}`);
    return captured;
  } catch (err) {
    logger.error(`[Razorpay] capturePayment failed: ${err.message}`);
    throw new AppError(`Payment capture failed: ${err.message}`, 502, "RAZORPAY_CAPTURE_FAILED");
  }
}

/**
 * Issue a full or partial refund for a payment.
 */
async function createRefund(paymentId, amount = null, notes = {}) {
  try {
    if (!razorpay) throw new Error("Razorpay is not configured on this server.");

    const payload = { notes };
    if (amount !== null) payload.amount = toPaise(amount);

    const refund = await razorpay.payments.refund(paymentId, payload);
    logger.info(`[Razorpay] Refund issued: ${refund.id} for payment ${paymentId}`);
    return refund;
  } catch (err) {
    logger.error(`[Razorpay] createRefund failed: ${err.message}`);
    throw new AppError(`Refund creation failed: ${err.message}`, 502, "RAZORPAY_REFUND_FAILED");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify the HMAC-SHA256 signature from a Razorpay webhook event.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    throw new AppError("RAZORPAY_WEBHOOK_SECRET is not set.", 500, "MISSING_ENV");
  }
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,  "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Verify the HMAC-SHA256 signature for a client-side payment completion.
 */
function verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, signature) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false; // Fail gracefully if keys are removed
  
  const body     = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected,  "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

module.exports = {
  createOrder,
  createPaymentLink,
  fetchPaymentLink,
  fetchPaymentDetails,
  capturePayment,
  createRefund,
  verifyWebhookSignature,
  verifyPaymentSignature,
};