import mongoose from 'mongoose';
import axios from 'axios';
import DeliveryCompany from '../models/DeliveryCompany.js';
import Order from '../models/Order.js';
import { StatusCodes } from 'http-status-codes';
import { sendToCompany, getDeliveryStatusFromCompany, testCompanyConnection, mapStatus, validateRequiredMappings, validateCompanyConfiguration } from '../services/deliveryIntegrationService.js';

// List companies (admin)
export const listCompanies = async (req, res) => {
  const companies = await DeliveryCompany.find().sort('name');
  res.json(companies);
};

// Public active companies
export const listActiveCompanies = async (req, res) => {
  const companies = await DeliveryCompany.find({ isActive: true }).sort('name');
  res.json(companies);
};

// Get one company
export const getCompany = async (req, res) => {
  const company = await DeliveryCompany.findById(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });
  res.json(company);
};

// Create company
export const createCompany = async (req, res) => {
  const company = new DeliveryCompany(req.body);
  await company.save();
  res.status(StatusCodes.CREATED).json(company);
};

// Update company
export const updateCompany = async (req, res) => {
  const body = { ...req.body };
  // If statusMapping present, sanitize invalid rows before update
  if (Array.isArray(body.statusMapping)) {
    body.statusMapping = body.statusMapping.filter(m =>
      m && typeof m.companyStatus === 'string' && m.companyStatus.trim() !== '' &&
      typeof m.internalStatus === 'string' && m.internalStatus.trim() !== ''
    );
  }
  const company = await DeliveryCompany.findByIdAndUpdate(
    req.params.id,
    body,
    { new: true, runValidators: true }
  );
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });
  res.json(company);
};

// Delete company
export const deleteCompany = async (req, res) => {
  const company = await DeliveryCompany.findByIdAndDelete(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });
  res.json({ message: 'Delivery company deleted successfully' });
};

// Update field mappings
export const updateFieldMappings = async (req, res) => {
  const { fieldMappings = [], customFields = {} } = req.body || {};
  const company = await DeliveryCompany.findById(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });
  company.fieldMappings = Array.isArray(fieldMappings) ? fieldMappings : [];
  company.customFields = (customFields && typeof customFields === 'object') ? customFields : {};

  // Sanitize statusMapping to avoid validation errors from incomplete entries
  if (Array.isArray(company.statusMapping)) {
    company.statusMapping = company.statusMapping.filter(m =>
      m && typeof m.companyStatus === 'string' && m.companyStatus.trim() !== '' &&
      typeof m.internalStatus === 'string' && m.internalStatus.trim() !== ''
    );
  }

  await company.save({ validateModifiedOnly: true });
  res.json({ message: 'Field mappings updated successfully' });
};

// Calculate delivery fee (simple model: flat or by amount tiers)
export const calculateDeliveryFee = async (req, res) => {
  const company = await DeliveryCompany.findById(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

  const { totalAmount = 0 } = req.body || {};
  // Basic example: free over 100, otherwise 5
  const fee = totalAmount >= 100 ? 0 : 5;
  res.json({ fee });
};

// Test connection (mock)
export const testConnection = async (req, res) => {
  const company = await DeliveryCompany.findById(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ success: false, message: 'Delivery company not found' });
  try {
    const result = await testCompanyConnection(company.toObject());
    res.json({ success: result.ok, message: `Connection to ${company.name} ${result.ok ? 'successful' : 'failed'}`, status: result.status });
  } catch (e) {
    res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: e.message });
  }
};

// Validate company configuration and expose effective param sources (including db)
export const validateCompanyConfig = async (req, res) => {
  const company = await DeliveryCompany.findById(req.params.id);
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

  const obj = company.toObject();
  const cfg = validateCompanyConfiguration(obj);

  const params = obj.apiConfiguration?.params || {};
  const query = obj.apiConfiguration?.queryParams || {};
  const credDb = obj.credentials?.database || obj.credentials?.db;
  const customDb = obj.customFields?.db;
  const envDb = process.env.DELIVERY_HUB_DB || process.env.ODOO_DB || process.env.DELIVERY_DB || null;

  const sources = {
    apiParamsDb: params.db ?? null,
    queryDb: query.db ?? null,
    credentialsDb: credDb ?? null,
    customFieldsDb: customDb ?? null,
    envDb,
  };

  const effectiveDb =
    (params.db ?? null) ??
    (envDb ?? null) ??
    (credDb ?? null) ??
    (customDb ?? null) ??
    (query.db ?? null);

  const authMethod = obj.apiConfiguration?.authMethod || 'none';
  const format = obj.apiConfiguration?.format || obj.apiFormat || 'rest';
  const requiredParams = obj.apiConfiguration?.requiredParams || [];

  res.json({
    success: cfg.ok,
    issues: cfg.issues,
    mode: cfg.mode,
    url: cfg.url,
    db: { effectiveDb: effectiveDb ?? null, sources },
    details: { authMethod, format, requiredParams }
  });
};

// Proxy external area/sub-area list fetch to avoid CORS in admin UI
export const proxyExternalList = async (req, res) => {
  const { url, headers, params, companyId, companyCode } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'url is required' });
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Only http/https URLs are allowed' });
  }
  try {
    let auth;
    let derivedHeaders = {};
    let timeoutMs = 15000;
    let mergedQueryParams = (params && typeof params === 'object') ? params : undefined;
    let apiConfiguration = {};
    let credentials = {};
    let jsonRpcPayload = null;
    let isJsonRpc = false;

    const sanitizeHeaders = (input) => {
      const out = {};
      if (!input || typeof input !== 'object') return out;
      for (const [rawKey, rawValue] of Object.entries(input)) {
        if (!rawKey) continue;
        const key = String(rawKey).trim();
        if (!key || key.startsWith('$')) continue;
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
        if (rawValue === undefined || rawValue === null) continue;
        const value = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue);
        if (!value || /[\r\n]/.test(value)) continue;
        if (value.includes('$__')) continue;
        out[key] = value;
      }
      return out;
    };

    if (companyId || companyCode) {
      const company = companyId
        ? await DeliveryCompany.findById(companyId)
        : await DeliveryCompany.findOne({ code: companyCode });
      if (!company) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });
      }
      apiConfiguration = company.apiConfiguration || {};
      credentials = company.credentials || {};
      const method = apiConfiguration.authMethod || 'none';
      derivedHeaders = sanitizeHeaders(apiConfiguration.headers || {});
      if (method === 'basic') {
        const username = apiConfiguration.username || credentials.username;
        const password = apiConfiguration.password || credentials.password;
        if (username || password) auth = { username, password };
      } else if (method === 'bearer') {
        const token = apiConfiguration.bearer || apiConfiguration.apiKey || credentials.token || credentials.apiKey;
        if (token) derivedHeaders.Authorization = `Bearer ${token}`;
      } else if (method === 'apiKey') {
        const key = apiConfiguration.apiKey || credentials.apiKey;
        const headerName = credentials.apiKeyHeader || apiConfiguration.apiKeyHeader || process.env.DELIVERY_HUB_API_KEY_HEADER || 'x-api-key';
        if (key) derivedHeaders[headerName] = key;
      }
      if (typeof apiConfiguration.timeoutMs === 'number') timeoutMs = apiConfiguration.timeoutMs;
      if (apiConfiguration.queryParams && typeof apiConfiguration.queryParams === 'object') {
        mergedQueryParams = {
          ...(apiConfiguration.queryParams || {}),
          ...(mergedQueryParams || {})
        };
      }

      isJsonRpc = (apiConfiguration.format || company.apiFormat || '').toLowerCase() === 'jsonrpc';
    }

    if (isJsonRpc) {
      const baseParams = (apiConfiguration.params && typeof apiConfiguration.params === 'object')
        ? apiConfiguration.params
        : {};
      const mergedParams = {
        ...baseParams,
        ...(credentials.login ? { login: credentials.login } : {}),
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.database ? { db: credentials.database } : {}),
        ...((params && typeof params === 'object') ? params : {})
      };

      jsonRpcPayload = {
        jsonrpc: '2.0',
        ...(apiConfiguration.jsonrpcOmitMethod ? {} : (apiConfiguration.method ? { method: apiConfiguration.method } : {})),
        params: mergedParams
      };
    }

    const requestHeaders = {
      ...derivedHeaders,
      ...sanitizeHeaders((headers && typeof headers === 'object') ? headers : {})
    };

    const response = isJsonRpc
      ? await axios.post(trimmed, jsonRpcPayload, {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            ...requestHeaders
          },
          auth,
          params: mergedQueryParams,
        })
      : await axios.get(trimmed, {
          timeout: timeoutMs,
          headers: requestHeaders,
          auth,
          params: mergedQueryParams,
        });
    res.json(response.data);
  } catch (e) {
    const status = e?.response?.status || StatusCodes.BAD_GATEWAY;
    const data = e?.response?.data;
    const message =
      (typeof data === 'string' ? data : null) ||
      data?.message ||
      data?.error ||
      data?.detail ||
      e?.message ||
      'Failed to fetch external list';
    res.status(status).json({ message, status, details: (data && typeof data === 'object') ? data : undefined });
  }
};

// Validate API configuration and show effective param resolution (e.g., db)
// (note) previous duplicate declaration removed

// Validate field mappings for an order and company
export const validateFieldMappings = async (req, res) => {
  const { orderId, companyId } = req.body || {};
  if (!orderId || !companyId) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'orderId and companyId are required' });
  }
  const [order, company] = await Promise.all([
    Order.findById(orderId),
    DeliveryCompany.findById(companyId)
  ]);
  if (!order) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Order not found' });
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

  const check = validateRequiredMappings(order.toObject(), company.toObject());
  const isValid = check.ok;
  res.json({
    success: true,
    data: {
      isValid,
      errors: isValid ? [] : ['Missing required fields'],
      missingFields: check.missing,
      invalidFields: [],
      payloadPreview: check.payload
    }
  });
};

// Bulk validation: check mappings for an order against multiple companies
export const validateAllFieldMappings = async (req, res) => {
  const { orderId, companyIds, activeOnly = true } = req.body || {};
  if (!orderId) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'orderId is required' });
  }
  const order = await Order.findById(orderId);
  if (!order) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Order not found' });

  const filter = {};
  if (Array.isArray(companyIds) && companyIds.length) {
    filter._id = { $in: companyIds };
  } else if (activeOnly) {
    filter.isActive = true;
  }
  const companies = await DeliveryCompany.find(filter).sort('name');
  const results = companies.map(c => {
    const check = validateRequiredMappings(order.toObject(), c.toObject());
    return {
      companyId: String(c._id),
      companyName: c.name,
      companyCode: c.code || '',
      isActive: c.isActive !== false,
      isValid: check.ok,
      missingFields: check.missing,
      payloadPreview: check.payload,
    };
  });
  res.json({ success: true, data: { allValid: results.every(r => r.isValid), results } });
};

// Send order to delivery company (mock integration)
export const sendOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { orderId, companyId, companyCode, deliveryFee = 0 } = req.body || {};
    if (!orderId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'orderId is required' });
    }

    // Resolve company by explicit id, code, default flag, or first active
    let company = null;
    if (companyId) {
      company = await DeliveryCompany.findById(companyId);
    } else if (companyCode) {
      company = await DeliveryCompany.findOne({ code: companyCode });
    }

    if (!company) {
      company = await DeliveryCompany.findOne({ isActive: true, isDefault: true })
        || await DeliveryCompany.findOne({ isActive: true }).sort('name');
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Order not found' });
    if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

    await session.startTransaction();

  // Validate company API configuration before sending
  const cfg = validateCompanyConfiguration(company.toObject());
  if (!cfg.ok) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      message: 'Delivery company configuration is incomplete',
      issues: cfg.issues,
      mode: cfg.mode,
      url: cfg.url
    });
  }

  // Validate required mappings before sending
  const check = validateRequiredMappings(order.toObject(), company.toObject());
  if (!check.ok) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      message: 'Missing required mapped fields',
      missingFields: check.missing,
      payloadPreview: check.payload
    });
  }

  // Build payload and send to provider
  const { trackingNumber, providerResponse, providerStatus } = await sendToCompany(order.toObject(), company.toObject(), { deliveryFee });

  order.deliveryCompany = company._id;
  order.deliveryStatus = mapStatus(company, providerStatus || 'assigned');
  order.deliveryTrackingNumber = trackingNumber;
  // Set legacy field as well for UI components expecting trackingNumber
  order.trackingNumber = trackingNumber;
  order.deliveryAssignedAt = new Date();
  order.deliveryFee = deliveryFee || 0;
  order.deliveryResponse = providerResponse;
  await order.save({ session });

    await session.commitTransaction();

    res.json({
      message: 'Order sent to delivery company',
      data: {
        trackingNumber,
        status: order.deliveryStatus,
        externalStatus: order.deliveryStatus,
        isResend: false,
        resendAttempts: 0,
        deliveryCompanyResponse: order.deliveryResponse
      }
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    // Return actionable errors for preflight problems
    if (error && (error.code === 'MAPPING_MISSING' || error.code === 'PARAMS_MISSING')) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        message: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {})
      });
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: error.message || 'Failed to send order' });
  } finally {
    await session.endSession();
  }
};

// Order-based send (legacy path used by some UI): /delivery/order
export const sendOrderWithOrderPayload = async (req, res) => {
  const { order, companyId, mappedData } = req.body || {};
  if (!order || !order._id || !companyId) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'order object with _id and companyId are required' });
  }
  // Delegate to sendOrder to keep single flow
  req.body = { orderId: order._id, companyId, deliveryFee: mappedData?.deliveryFee || 0 };
  return sendOrder(req, res);
};

// Check delivery status (mock)
export const getDeliveryStatus = async (req, res) => {
  const { orderId } = req.params;
  const order = await Order.findById(orderId).populate('deliveryCompany');
  if (!order) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Order not found' });
  if (!order.deliveryCompany) return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Order not assigned to delivery' });
  const status = await getDeliveryStatusFromCompany(order, order.deliveryCompany);
  const internal = mapStatus(order.deliveryCompany, status.status);
  res.json({ success: true, ...status, status: internal, internalStatus: internal });
};

// Batch assign multiple orders to a delivery company (no external send, just assignment + optional tracking/status)
export const batchAssignOrders = async (req, res) => {
  try {
    const { orderIds, companyId, trackingNumber, deliveryStatus, orderStatus } = req.body || {};
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'orderIds array is required' });
    }
    if (!companyId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'companyId is required' });
    }
    const company = await DeliveryCompany.findById(companyId);
    if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

    const update = {
      deliveryCompany: company._id,
      deliveryAssignedAt: new Date()
    };
    if (trackingNumber) {
      update.deliveryTrackingNumber = trackingNumber;
      update.trackingNumber = trackingNumber; // legacy
    }
    if (deliveryStatus) update.deliveryStatus = deliveryStatus;
    if (orderStatus) update.status = orderStatus;

    const result = await Order.updateMany({ _id: { $in: orderIds } }, { $set: update });
    res.json({
      success: true,
      message: 'Orders assigned to delivery company',
      modifiedCount: result.modifiedCount || result.nModified || 0,
      company: { id: String(company._id), name: company.name }
    });
  } catch (err) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: err.message || 'Batch assignment failed' });
  }
};

// Batch send multiple orders to a delivery company using existing sendOrder logic components
export const batchSendOrders = async (req, res) => {
  const { orderIds, companyId, companyCode, deliveryFee = 0, stopOnError = false } = req.body || {};
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'orderIds array is required' });
  }
  let company = null;
  if (companyId) {
    company = await DeliveryCompany.findById(companyId);
  } else if (companyCode) {
    company = await DeliveryCompany.findOne({ code: companyCode });
  }
  if (!company) {
    company = await DeliveryCompany.findOne({ isActive: true, isDefault: true })
      || await DeliveryCompany.findOne({ isActive: true }).sort('name');
  }
  if (!company) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Delivery company not found' });

  const results = [];
  for (const orderId of orderIds) {
    try {
      // Reuse portions of sendOrder flow (without duplicating entire code) by manually replicating essential steps
      const order = await Order.findById(orderId);
      if (!order) throw new Error('Order not found');

      // Validate configuration & required mappings
      const cfg = validateCompanyConfiguration(company.toObject());
      if (!cfg.ok) {
        throw Object.assign(new Error('Delivery company configuration incomplete'), { code: 'CONFIG_INVALID', details: cfg.issues });
      }
      const mappingCheck = validateRequiredMappings(order.toObject(), company.toObject());
      if (!mappingCheck.ok) {
        throw Object.assign(new Error('Missing required mapped fields'), { code: 'MAPPING_MISSING', missing: mappingCheck.missing });
      }

      const { trackingNumber, providerResponse, providerStatus } = await sendToCompany(order.toObject(), company.toObject(), { deliveryFee });
      order.deliveryCompany = company._id;
      order.deliveryStatus = mapStatus(company, providerStatus || 'assigned');
      order.deliveryTrackingNumber = trackingNumber;
      order.trackingNumber = trackingNumber; // legacy mirror
      order.deliveryAssignedAt = new Date();
      order.deliveryFee = deliveryFee || 0;
      order.deliveryResponse = providerResponse;
      await order.save();

      results.push({ orderId, success: true, trackingNumber, status: order.deliveryStatus });
    } catch (err) {
      const entry = { orderId, success: false, error: err.message || 'Failed', code: err.code };
      if (err.missing) entry.missing = err.missing;
      results.push(entry);
      if (stopOnError) break;
    }
  }

  res.json({
    success: results.every(r => r.success),
    company: { id: String(company._id), name: company.name },
    summary: {
      total: orderIds.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    },
    results
  });
};

// List delivery-related orders (simple list of orders with delivery info)
export const listDeliveryOrders = async (req, res) => {
  const { orderId, limit = 50 } = req.query;
  const filter = {};
  if (orderId) filter._id = orderId;
  const orders = await Order.find(filter)
    .populate('deliveryCompany')
    .sort('-deliveryAssignedAt')
    .limit(Number(limit));
  // Map to delivery-centric shape expected by some frontend components
  const mapped = orders.map(o => ({
    _id: o._id,
    orderNumber: o.orderNumber,
    status: o.deliveryStatus || 'assigned',
    trackingNumber: o.deliveryTrackingNumber || o.trackingNumber,
    deliveryCompany: o.deliveryCompany ? {
      _id: o.deliveryCompany._id,
      name: o.deliveryCompany.name,
      code: o.deliveryCompany.code || ''
    } : null,
    createdAt: o.deliveryAssignedAt || o.createdAt,
    customerInfo: o.customerInfo
  }));
  res.json({ data: mapped, docs: mapped });
};
