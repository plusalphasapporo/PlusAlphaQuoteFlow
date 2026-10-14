
import { withSupabase } from 'npm:@supabase/server'

type SyncImportItem = {
  folderId?: string
  proposedName?: string
}

type Body = {
  action?: 'link_folder' | 'get_folder' | 'versions' | 'unlink_folder' | 'sync_preview' | 'import_selected' | 'get_quick_link'
  customerId?: string
  ticketId?: string
  folderUrl?: string
  itemId?: string
  items?: SyncImportItem[]
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)

function decodePath(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function normalizeServerRelativeFolderUrl(rawUrl: string) {
  const u = new URL(rawUrl)
  if (!u.hostname.toLowerCase().endsWith('.sharepoint.com')) {
    throw new Error('SHAREPOINT_URL_REQUIRED')
  }

  let serverRelative = ''
  const idParam = u.searchParams.get('id')
  if (idParam) {
    serverRelative = decodePath(idParam)
  } else {
    serverRelative = decodePath(u.pathname)
      .replace(/^\/:f:\/r/i, '')
      .replace(/^\/:f:\/s/i, '')
      .replace(/^\/:f:\/g/i, '')
  }

  if (!serverRelative.startsWith('/')) serverRelative = '/' + serverRelative
  serverRelative = serverRelative.replace(/\/Forms\/AllItems\.aspx$/i, '')
  serverRelative = serverRelative.replace(/\/+$/, '')

  return { host: u.hostname, serverRelative, originalUrl: rawUrl }
}

function splitSharePointPath(serverRelative: string) {
  const parts = serverRelative.split('/').filter(Boolean)
  if (!parts.length) {
    return { sitePath: '/', libraryPath: '' }
  }

  const first = parts[0].toLowerCase()
  if (['sites','teams','personal'].includes(first) && parts.length >= 2) {
    return {
      sitePath: '/' + parts.slice(0, 2).join('/'),
      libraryPath: '/' + parts.slice(2).join('/'),
    }
  }

  return { sitePath: '/', libraryPath: '/' + parts.join('/') }
}

async function resolveSharePointFolder(token: string, rawUrl: string) {
  const parsed = normalizeServerRelativeFolderUrl(rawUrl)
  const paths = splitSharePointPath(parsed.serverRelative)

  const sitePath = paths.sitePath === '/' ? '' : paths.sitePath
  const site = await graphGet(
    token,
    '/sites/' + encodeURIComponent(parsed.host) + ':' + sitePath +
    '?$select=id,displayName,webUrl',
  )

  const drives = await graphGet(
    token,
    '/sites/' + encodeURIComponent(site.id) +
    '/drives?$select=id,name,webUrl,driveType',
  )

  const allDrives = Array.isArray(drives?.value) ? drives.value : []
  if (!allDrives.length) throw new Error('SHAREPOINT_DRIVE_NOT_FOUND')

  const folderUrl = new URL(rawUrl)
  const desiredPath = decodePath(
    folderUrl.searchParams.get('id') || parsed.serverRelative,
  ).replace(/\/+$/, '').toLowerCase()

  let drive = allDrives
    .map((d: any) => {
      let drivePath = ''
      try { drivePath = decodePath(new URL(d.webUrl).pathname).replace(/\/+$/, '').toLowerCase() } catch {}
      return { d, drivePath }
    })
    .filter((x: any) => x.drivePath && desiredPath.startsWith(x.drivePath))
    .sort((a: any, b: any) => b.drivePath.length - a.drivePath.length)[0]?.d || null

  if (!drive) {
    const wantedLibrary = paths.libraryPath.split('/').filter(Boolean)[0]?.toLowerCase() || ''
    drive = allDrives.find((d: any) => String(d.name || '').toLowerCase() === wantedLibrary) || null
  }

  if (!drive && allDrives.length === 1) drive = allDrives[0]
  if (!drive) throw new Error('SHAREPOINT_LIBRARY_NOT_FOUND')

  let driveRootPath = ''
  try {
    driveRootPath = decodePath(new URL(drive.webUrl).pathname).replace(/\/+$/, '')
  } catch {}

  let folderPath = parsed.serverRelative
  if (driveRootPath && folderPath.toLowerCase().startsWith(driveRootPath.toLowerCase())) {
    folderPath = folderPath.slice(driveRootPath.length)
  } else if (paths.sitePath && folderPath.toLowerCase().startsWith(paths.sitePath.toLowerCase())) {
    folderPath = folderPath.slice(paths.sitePath.length)
    const libParts = folderPath.split('/').filter(Boolean)
    if (libParts.length) libParts.shift()
    folderPath = '/' + libParts.join('/')
  }

  folderPath = folderPath.replace(/^\/+|\/+$/g, '')
  let item
  if (!folderPath) {
    item = await graphGet(
      token,
      '/drives/' + encodeURIComponent(drive.id) +
      '/root?$select=id,name,webUrl,parentReference,folder',
    )
  } else {
    const encodedPath = folderPath.split('/').map(encodeURIComponent).join('/')
    item = await graphGet(
      token,
      '/drives/' + encodeURIComponent(drive.id) +
      '/root:/' + encodedPath +
      '?$select=id,name,webUrl,parentReference,folder',
    )
  }

  if (!item?.folder) throw new Error('URL_IS_NOT_A_FOLDER')

  return {
    driveId: String(drive.id),
    itemId: String(item.id),
    folderName: item.name || null,
    webUrl: item.webUrl || rawUrl,
    siteId: String(site.id || ''),
    siteName: site.displayName || null,
    libraryName: drive.name || null,
  }
}

async function graphToken() {
  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID') || ''
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID') || ''
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET') || ''
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MICROSOFT_GRAPH_NOT_CONFIGURED')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })

  const res = await fetch(
    'https://login.microsoftonline.com/' + encodeURIComponent(tenantId) + '/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  )

  const data = await res.json()
  if (!res.ok || !data?.access_token) {
    throw new Error('MICROSOFT_GRAPH_TOKEN_FAILED')
  }
  return String(data.access_token)
}

async function graphGet(token: string, path: string) {
  const res = await fetch('https://graph.microsoft.com/v1.0' + path, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data?.error?.message || ('Graph HTTP ' + res.status)
    const err = new Error(message)
    ;(err as any).status = res.status
    throw err
  }
  return data
}

function normalizeCustomerName(value: string) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^[ぁ-んァ-ヶーa-zA-Z0-9]+[：:]/, '')
    .replace(/[\s　]/g, '')
    .replace(/[（）()]/g, '')
    .replace(/株式会社/g, '')
    .replace(/有限会社/g, '')
    .replace(/合同会社/g, '')
    .replace(/一般社団法人/g, '')
    .replace(/特定非営利活動法人/g, '')
    .replace(/NPO法人/gi, '')
    .replace(/医療法人/g, '')
    .replace(/社会福祉法人/g, '')
    .toLowerCase()
}

function proposedCustomerName(folderName: string) {
  return String(folderName || '')
    .normalize('NFKC')
    .replace(/^[^：:]{1,12}[：:]/, '')
    .trim()
}

async function loadCustomerFolderRoot(ctx: any) {
  const { data: root, error } = await ctx.supabase
    .from('m365_customer_folder_roots')
    .select('drive_id,item_id,display_path')
    .eq('root_key', 'customer_data')
    .maybeSingle()
  if (error) throw new Error('CUSTOMER_FOLDER_ROOT_READ_FAILED:' + error.message)
  if (!root?.drive_id || !root?.item_id) throw new Error('CUSTOMER_FOLDER_ROOT_NOT_CONFIGURED')
  return root
}

async function listCustomerFolders(ctx: any, token: string) {
  const root = await loadCustomerFolderRoot(ctx)
  const children = await graphGet(
    token,
    '/drives/' + encodeURIComponent(root.drive_id) + '/items/' + encodeURIComponent(root.item_id) +
    '/children?$select=id,name,webUrl,folder&$top=999',
  )
  return {
    root,
    folders: (children?.value || []).filter((x: any) => x?.folder),
  }
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)

    const aal = String(ctx.jwtClaims?.aal ?? 'aal1')
    if (aal !== 'aal2') return json({ error: 'AAL2_REQUIRED' }, 403)

    const actorUserId = String(ctx.jwtClaims?.sub ?? '')
    const { data: profile, error: profileError } = await ctx.supabase
      .from('profiles')
      .select('role,is_active')
      .eq('user_id', actorUserId)
      .single()

    if (profileError || !profile || profile.is_active !== true) {
      return json({ error: 'ACCOUNT_DISABLED_OR_MISSING' }, 403)
    }
    let body: Body
    try {
      body = await req.json()
    } catch {
      return json({ error: 'INVALID_JSON' }, 400)
    }

    const action = body.action || 'get_folder'

    // Ticket-scoped, read-only shortcut. Support staff may only request this
    // action for a customer on a ticket they can read through ordinary RLS.
    // Never return Microsoft Graph tokens, drive IDs, file listings or secrets.
    const internalRole = ['internal_admin', 'internal_staff'].includes(profile.role)
    if (!internalRole && !(profile.role === 'support_staff' && action === 'get_quick_link')) {
      return json({ error: 'INTERNAL_REQUIRED' }, 403)
    }
    if (action === 'get_quick_link') {
      if (!isUuid(body.customerId)) return json({ error: 'INVALID_CUSTOMER_ID' }, 400)
      if (profile.role === 'support_staff') {
        if (!isUuid(body.ticketId)) return json({ error: 'INVALID_TICKET_ID' }, 400)
        const { data: ticket, error: ticketError } = await ctx.supabase
          .from('support_tickets')
          .select('customer_id')
          .eq('id', body.ticketId)
          .single()
        if (ticketError || !ticket || ticket.customer_id !== body.customerId) {
          return json({ error: 'TICKET_NOT_FOUND_OR_FORBIDDEN' }, 404)
        }
      }
      const { data: customer, error: customerError } = await ctx.supabaseAdmin
        .from('customers')
        .select('id,name,customer_code')
        .eq('id', body.customerId)
        .single()
      if (customerError || !customer) return json({ error: 'CUSTOMER_NOT_FOUND' }, 404)

      const safeFolderUrl = (raw: unknown): string => {
        try {
          const parsed = new URL(String(raw || ''))
          if (parsed.protocol !== 'https:' || !parsed.hostname.toLowerCase().endsWith('.sharepoint.com')) return ''
          return parsed.href
        } catch { return '' }
      }
      const { data: mapping, error: mappingError } = await ctx.supabaseAdmin
        .from('customer_onedrive_folders')
        .select('web_url,folder_name')
        .eq('customer_id', customer.id)
        .maybeSingle()
      if (mappingError) return json({ error: 'FOLDER_LINK_READ_FAILED' }, 503)
      if (mapping) {
        const webUrl = safeFolderUrl(mapping.web_url)
        return webUrl
          ? json({ ok: true, linked: true, webUrl, source: 'mapped' })
          : json({ ok: true, linked: false, reason: 'invalid_stored_url' })
      }

      // Read-only fallback while existing customers are still unlinked.
      // Only a UNIQUE, exact normalized name/code match is acceptable.
      // Loose/similar matches are deliberately rejected to prevent cross-customer access.
      const { data: root, error: rootError } = await ctx.supabaseAdmin
        .from('m365_customer_folder_roots')
        .select('drive_id,item_id')
        .eq('root_key', 'customer_data')
        .maybeSingle()
      if (rootError || !root?.drive_id || !root?.item_id) {
        return json({ ok: true, linked: false, reason: 'root_not_configured' })
      }
      try {
        const token = await graphToken()
        const children = await graphGet(
          token,
          '/drives/' + encodeURIComponent(root.drive_id) + '/items/' + encodeURIComponent(root.item_id) +
          '/children?$select=id,name,webUrl,folder&$top=999',
        )
        const names = [customer.name, customer.customer_code]
          .map((x: unknown) => normalizeCustomerName(String(x || '')))
          .filter((x: string) => x.length >= 3)
        const matches = (children?.value || []).filter((x: any) =>
          !!x?.folder && names.includes(normalizeCustomerName(String(x.name || ''))))
        if (matches.length !== 1) {
          return json({ ok: true, linked: false, reason: 'needs_manual_link' })
        }
        const webUrl = safeFolderUrl(matches[0].webUrl)
        return webUrl
          ? json({ ok: true, linked: true, webUrl, source: 'unique_exact_match' })
          : json({ ok: true, linked: false, reason: 'missing_folder_url' })
      } catch (_error) {
        return json({ ok: true, linked: false, reason: 'folder_lookup_unavailable' })
      }
    }

    if (action === 'sync_preview' || action === 'import_selected') {
      if (profile.role !== 'internal_admin') return json({ error: 'ADMIN_REQUIRED' }, 403)

      const token = await graphToken()
      const { root, folders } = await listCustomerFolders(ctx, token)

      const { data: customers, error: customersError } = await ctx.supabase
        .from('customers')
        .select('id,name,customer_code')
      if (customersError) return json({ error: 'CUSTOMER_LIST_FAILED', message: customersError.message }, 500)

      const { data: mappings, error: mappingsError } = await ctx.supabase
        .from('customer_onedrive_folders')
        .select('customer_id,item_id,folder_name')
      if (mappingsError) return json({ error: 'FOLDER_MAPPING_LIST_FAILED', message: mappingsError.message }, 500)

      const customerById = new Map((customers || []).map((x: any) => [x.id, x]))
      const mappingByItem = new Map((mappings || []).map((x: any) => [x.item_id, x]))
      const normalizedCustomers = (customers || []).map((x: any) => ({
        ...x,
        normalized: normalizeCustomerName(String(x.name || '')),
      }))

      if (action === 'sync_preview') {
        const rows = folders.map((folder: any) => {
          const mapped = mappingByItem.get(String(folder.id))
          if (mapped) {
            const customer = customerById.get(mapped.customer_id)
            return {
              folderId: String(folder.id),
              folderName: folder.name || '',
              webUrl: folder.webUrl || '',
              proposedName: customer?.name || proposedCustomerName(folder.name || ''),
              status: 'matched',
              matchedCustomerId: customer?.id || mapped.customer_id,
              matchedCustomerName: customer?.name || mapped.folder_name || '',
              reason: 'linked',
            }
          }

          const normalizedFolder = normalizeCustomerName(String(folder.name || ''))
          const exact = normalizedCustomers.filter((x: any) => x.normalized && x.normalized === normalizedFolder)
          if (exact.length === 1) {
            return {
              folderId: String(folder.id),
              folderName: folder.name || '',
              webUrl: folder.webUrl || '',
              proposedName: exact[0].name,
              status: 'matched',
              matchedCustomerId: exact[0].id,
              matchedCustomerName: exact[0].name,
              reason: 'exact_name',
            }
          }

          const loose = normalizedCustomers.filter((x: any) =>
            x.normalized && normalizedFolder && x.normalized.length >= 3 &&
            (x.normalized.includes(normalizedFolder) || normalizedFolder.includes(x.normalized))
          )

          if (exact.length > 1 || loose.length) {
            return {
              folderId: String(folder.id),
              folderName: folder.name || '',
              webUrl: folder.webUrl || '',
              proposedName: proposedCustomerName(folder.name || ''),
              status: 'review',
              candidates: (exact.length ? exact : loose).slice(0,5).map((x: any) => ({
                id: x.id,
                name: x.name,
                customer_code: x.customer_code,
              })),
              reason: exact.length > 1 ? 'multiple_exact' : 'similar_name',
            }
          }

          return {
            folderId: String(folder.id),
            folderName: folder.name || '',
            webUrl: folder.webUrl || '',
            proposedName: proposedCustomerName(folder.name || ''),
            status: 'unregistered',
            reason: 'not_found',
          }
        })

        const summary = {
          total: rows.length,
          matched: rows.filter((x: any) => x.status === 'matched').length,
          unregistered: rows.filter((x: any) => x.status === 'unregistered').length,
          review: rows.filter((x: any) => x.status === 'review').length,
        }

        return json({ ok: true, root, summary, rows })
      }

      const selected = Array.isArray(body.items) ? body.items.slice(0,200) : []
      if (!selected.length) return json({ error: 'IMPORT_ITEMS_REQUIRED' }, 400)

      const folderById = new Map(folders.map((x: any) => [String(x.id), x]))
      const results: any[] = []

      for (const item of selected) {
        const folderId = String(item?.folderId || '')
        const folder = folderById.get(folderId)
        const name = String(item?.proposedName || '').trim()

        if (!folder || !name) {
          results.push({ folderId, status: 'skipped', reason: 'invalid_item' })
          continue
        }

        const existingMapping = mappingByItem.get(folderId)
        if (existingMapping) {
          const existingCustomer = customerById.get(existingMapping.customer_id)
          results.push({
            folderId,
            folderName: folder.name,
            status: 'matched',
            customerId: existingMapping.customer_id,
            customerName: existingCustomer?.name || '',
            reason: 'already_linked',
          })
          continue
        }

        const normalizedName = normalizeCustomerName(name)
        const exact = normalizedCustomers.find((x: any) => x.normalized === normalizedName)
        let customerId = exact?.id || null
        let customerName = exact?.name || name
        let customerCode = exact?.customer_code || null
        let created = false

        if (!customerId) {
          const similar = normalizedCustomers.filter((x: any) =>
            x.normalized && normalizedName.length >= 3 &&
            (x.normalized.includes(normalizedName) || normalizedName.includes(x.normalized))
          )
          if (similar.length) {
            results.push({
              folderId,
              folderName: folder.name,
              status: 'review',
              reason: 'similar_customer_exists',
              candidates: similar.slice(0,5).map((x: any) => ({
                id:x.id,name:x.name,customer_code:x.customer_code
              })),
            })
            continue
          }

          const { data: newCustomer, error: createError } = await ctx.supabase.rpc(
            'create_customer_with_profile',
            {
              p_customer_code:null,
              p_name:name,
              p_trade_name:null,
              p_customer_type:'corporation',
              p_name_kana:null,
              p_corporate_number:null,
              p_representative_name:null,
              p_representative_title:null,
              p_industry:null,
              p_established_date:null,
              p_fiscal_month:null,
              p_employee_count:null,
              p_sales_owner_user_id:null,
              p_relationship_started_on:null,
              p_lead_source:'SharePoint顧客フォルダ',
              p_branch_type:'head_office',
              p_parent_customer_id:null,
              p_postal_code:null,
              p_address1:null,
              p_address2:null,
              p_phone:null,
              p_mobile:null,
              p_fax:null,
              p_email:null,
              p_website:null,
              p_support_company_id:null,
              p_internal_note:'SharePoint既存顧客フォルダから同期登録',
              p_manual_hold:false,
              p_contact_name:null,
              p_contact_title:null,
              p_contact_email:null,
              p_contact_phone:null,
              p_contact_mobile_e164:null,
              p_contact_preferred_channel:null,
              p_contact_primary:true,
            },
          )

          if (createError || !newCustomer?.id) {
            results.push({
              folderId,
              folderName: folder.name,
              status: 'error',
              reason: 'customer_create_failed',
              message: createError?.message || 'customer create failed',
            })
            continue
          }

          customerId = newCustomer.id
          customerName = newCustomer.name || name
          customerCode = newCustomer.customer_code || null
          created = true

          normalizedCustomers.push({
            id: customerId,
            name: customerName,
            customer_code: customerCode,
            normalized: normalizeCustomerName(customerName),
          })
          customerById.set(customerId, {
            id:customerId,name:customerName,customer_code:customerCode
          })
        }

        const mapRow = {
          customer_id: customerId,
          drive_id: root.drive_id,
          item_id: folderId,
          folder_name: folder.name || null,
          web_url: folder.webUrl || '',
          linked_by: actorUserId,
          linked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        const { error: mapError } = await ctx.supabase
          .from('customer_onedrive_folders')
          .upsert(mapRow, { onConflict: 'customer_id' })

        if (mapError) {
          results.push({
            folderId,
            folderName: folder.name,
            status: 'error',
            reason: 'folder_link_failed',
            message: mapError.message,
            customerId,
            customerName,
          })
          continue
        }

        mappingByItem.set(folderId, mapRow)
        results.push({
          folderId,
          folderName: folder.name,
          status: created ? 'created' : 'matched',
          customerId,
          customerName,
          customerCode,
          created,
        })
      }

      return json({
        ok:true,
        summary:{
          requested:selected.length,
          created:results.filter(x=>x.status==='created').length,
          matched:results.filter(x=>x.status==='matched').length,
          review:results.filter(x=>x.status==='review').length,
          error:results.filter(x=>x.status==='error').length,
          skipped:results.filter(x=>x.status==='skipped').length,
        },
        results,
      })
    }

    if (!isUuid(body.customerId)) return json({ error: 'INVALID_CUSTOMER_ID' }, 400)
    const customerId = body.customerId

    const { data: customer, error: customerError } = await ctx.supabase
      .from('customers')
      .select('id,name,customer_code')
      .eq('id', customerId)
      .single()
    if (customerError || !customer) return json({ error: 'CUSTOMER_NOT_FOUND' }, 404)

    if (action === 'link_folder') {
      if (profile.role !== 'internal_admin') return json({ error: 'ADMIN_REQUIRED' }, 403)
      const folderUrl = typeof body.folderUrl === 'string' ? body.folderUrl.trim() : ''
      if (!/^https:\/\//i.test(folderUrl)) return json({ error: 'INVALID_FOLDER_URL' }, 400)

      const token = await graphToken()
      let resolved
      try {
        resolved = await resolveSharePointFolder(token, folderUrl)
      } catch (error) {
        const message = String((error as Error)?.message || error)
        if (message === 'SHAREPOINT_URL_REQUIRED') return json({ error: message }, 400)
        if (message === 'SHAREPOINT_DRIVE_NOT_FOUND' || message === 'SHAREPOINT_LIBRARY_NOT_FOUND') {
          return json({ error: message }, 404)
        }
        if (message === 'URL_IS_NOT_A_FOLDER') return json({ error: message }, 400)
        throw error
      }

      const row = {
        customer_id: customerId,
        drive_id: resolved.driveId,
        item_id: resolved.itemId,
        folder_name: resolved.folderName,
        web_url: resolved.webUrl,
        linked_by: actorUserId,
        linked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const { error: upsertError } = await ctx.supabase
        .from('customer_onedrive_folders')
        .upsert(row, { onConflict: 'customer_id' })

      if (upsertError) return json({ error: 'FOLDER_LINK_SAVE_FAILED', message: upsertError.message }, 500)

      await ctx.supabase.from('audit_logs').insert({
        actor_user_id: actorUserId,
        actor_role: profile.role,
        action: 'customer.onedrive_folder_linked',
        target_type: 'customer',
        target_id: customerId,
        after_data: {
          folder_name: row.folder_name,
          web_url: row.web_url,
          drive_id: row.drive_id,
          item_id: row.item_id,
          site_id: resolved.siteId,
          site_name: resolved.siteName,
          library_name: resolved.libraryName,
        },
        user_agent: req.headers.get('user-agent'),
        request_id: req.headers.get('x-request-id'),
      })

      return json({ ok: true, folder: row })
    }

    if (action === 'unlink_folder') {
      if (profile.role !== 'internal_admin') return json({ error: 'ADMIN_REQUIRED' }, 403)

      const { data: existing } = await ctx.supabase
        .from('customer_onedrive_folders')
        .select('*')
        .eq('customer_id', customerId)
        .maybeSingle()

      const { error: deleteError } = await ctx.supabase
        .from('customer_onedrive_folders')
        .delete()
        .eq('customer_id', customerId)
      if (deleteError) return json({ error: 'FOLDER_UNLINK_FAILED', message: deleteError.message }, 500)

      await ctx.supabase.from('audit_logs').insert({
        actor_user_id: actorUserId,
        actor_role: profile.role,
        action: 'customer.onedrive_folder_unlinked',
        target_type: 'customer',
        target_id: customerId,
        before_data: existing || null,
        user_agent: req.headers.get('user-agent'),
        request_id: req.headers.get('x-request-id'),
      })

      return json({ ok: true })
    }

    let { data: mapping, error: mappingError } = await ctx.supabase
      .from('customer_onedrive_folders')
      .select('customer_id,drive_id,item_id,folder_name,web_url,linked_at,updated_at')
      .eq('customer_id', customerId)
      .maybeSingle()

    if (mappingError) return json({ error: 'FOLDER_LINK_READ_FAILED', message: mappingError.message }, 500)

    const token = await graphToken()

    if (!mapping) {
      const { data: root, error: rootError } = await ctx.supabase
        .from('m365_customer_folder_roots')
        .select('drive_id,item_id,display_path')
        .eq('root_key', 'customer_data')
        .maybeSingle()

      if (rootError) {
        return json({ error: 'CUSTOMER_FOLDER_ROOT_READ_FAILED', message: rootError.message }, 500)
      }

      if (root?.drive_id && root?.item_id) {
        const children = await graphGet(
          token,
          '/drives/' + encodeURIComponent(root.drive_id) + '/items/' + encodeURIComponent(root.item_id) +
          '/children?$select=id,name,webUrl,folder&$top=999',
        )

        const targets = [
          normalizeCustomerName(String(customer.name || '')),
          normalizeCustomerName(String(customer.customer_code || '')),
        ].filter(Boolean)

        const candidates = (children?.value || []).filter((x: any) => x?.folder)
        const exact = candidates.find((x: any) => targets.includes(normalizeCustomerName(String(x.name || ''))))
        const loose = exact || candidates.find((x: any) => {
          const n = normalizeCustomerName(String(x.name || ''))
          return targets.some((t) => t.length >= 3 && (n.includes(t) || t.includes(n)))
        })

        if (loose) {
          const autoRow = {
            customer_id: customerId,
            drive_id: root.drive_id,
            item_id: String(loose.id),
            folder_name: loose.name || null,
            web_url: loose.webUrl || '',
            linked_by: actorUserId,
            linked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }

          const { error: autoSaveError } = await ctx.supabase
            .from('customer_onedrive_folders')
            .upsert(autoRow, { onConflict: 'customer_id' })

          if (!autoSaveError) mapping = autoRow
        }
      }
    }

    if (!mapping) return json({ ok: true, linked: false, customer, autoMatchTried: true })

    if (action === 'versions') {
      const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
      if (!itemId) return json({ error: 'ITEM_ID_REQUIRED' }, 400)

      const item = await graphGet(
        token,
        '/drives/' + encodeURIComponent(mapping.drive_id) + '/items/' + encodeURIComponent(itemId) +
        '?$select=id,name,webUrl,size,file,folder,lastModifiedDateTime,lastModifiedBy,parentReference',
      )
      if (!item?.file) return json({ error: 'VERSIONS_ONLY_FOR_FILES' }, 400)

      const versions = await graphGet(
        token,
        '/drives/' + encodeURIComponent(mapping.drive_id) + '/items/' + encodeURIComponent(itemId) +
        '/versions?$select=id,lastModifiedDateTime,size,lastModifiedBy,publishingLevel',
      )

      return json({
        ok: true,
        linked: true,
        item,
        versions: versions?.value || [],
      })
    }

    const itemId = typeof body.itemId === 'string' && body.itemId.trim()
      ? body.itemId.trim()
      : mapping.item_id

    const [current, children] = await Promise.all([
      graphGet(
        token,
        '/drives/' + encodeURIComponent(mapping.drive_id) + '/items/' + encodeURIComponent(itemId) +
        '?$select=id,name,webUrl,folder,parentReference,lastModifiedDateTime,lastModifiedBy',
      ),
      graphGet(
        token,
        '/drives/' + encodeURIComponent(mapping.drive_id) + '/items/' + encodeURIComponent(itemId) +
        '/children?$select=id,name,webUrl,size,folder,file,lastModifiedDateTime,lastModifiedBy,createdDateTime,createdBy,parentReference&$orderby=name',
      ),
    ])

    return json({
      ok: true,
      linked: true,
      customer,
      mapping,
      current,
      rootItemId: mapping.item_id,
      items: children?.value || [],
    })
  }),
}
