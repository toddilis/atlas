export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_price_books: {
        Row: {
          account_id: string
          effective_from: string
          price_book_id: string
        }
        Insert: {
          account_id: string
          effective_from?: string
          price_book_id: string
        }
        Update: {
          account_id?: string
          effective_from?: string
          price_book_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_price_books_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_price_books_price_book_id_fkey"
            columns: ["price_book_id"]
            isOneToOne: false
            referencedRelation: "price_books"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          billing_email: string | null
          created_at: string
          currency: string
          id: string
          legal_name: string | null
          name: string
          notes: string | null
          org_id: string
          payment_terms_days: number
          status: string
          updated_at: string
        }
        Insert: {
          billing_email?: string | null
          created_at?: string
          currency?: string
          id?: string
          legal_name?: string | null
          name: string
          notes?: string | null
          org_id: string
          payment_terms_days?: number
          status?: string
          updated_at?: string
        }
        Update: {
          billing_email?: string | null
          created_at?: string
          currency?: string
          id?: string
          legal_name?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          payment_terms_days?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_activity: {
        Row: {
          agent_name: string
          detail: Json | null
          event_id: string | null
          id: string
          kind: string
          occurred_at: string
          org_id: string
          subject_id: string | null
          subject_type: string | null
          summary: string
        }
        Insert: {
          agent_name: string
          detail?: Json | null
          event_id?: string | null
          id?: string
          kind: string
          occurred_at?: string
          org_id: string
          subject_id?: string | null
          subject_type?: string | null
          summary: string
        }
        Update: {
          agent_name?: string
          detail?: Json | null
          event_id?: string | null
          id?: string
          kind?: string
          occurred_at?: string
          org_id?: string
          subject_id?: string | null
          subject_type?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_activity_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "event_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_activity_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          created_at: string
          description: string | null
          domain: string
          enabled: boolean
          id: string
          kind: Database["public"]["Enums"]["agent_kind"]
          name: string
          org_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          domain: string
          enabled?: boolean
          id?: string
          kind: Database["public"]["Enums"]["agent_kind"]
          name: string
          org_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          domain?: string
          enabled?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["agent_kind"]
          name?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          action: string
          agent_name: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          expires_at: string | null
          id: string
          org_id: string
          payload: Json
          proposed_summary: string | null
          reason: string | null
          risk: Database["public"]["Enums"]["risk_tier"]
          state: Database["public"]["Enums"]["approval_state"]
          subject_id: string | null
          subject_type: string
        }
        Insert: {
          action: string
          agent_name: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          expires_at?: string | null
          id?: string
          org_id: string
          payload: Json
          proposed_summary?: string | null
          reason?: string | null
          risk: Database["public"]["Enums"]["risk_tier"]
          state?: Database["public"]["Enums"]["approval_state"]
          subject_id?: string | null
          subject_type: string
        }
        Update: {
          action?: string
          agent_name?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          expires_at?: string | null
          id?: string
          org_id?: string
          payload?: Json
          proposed_summary?: string | null
          reason?: string | null
          risk?: Database["public"]["Enums"]["risk_tier"]
          state?: Database["public"]["Enums"]["approval_state"]
          subject_id?: string | null
          subject_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          agent_name: string
          approval_id: string | null
          detail: Json | null
          id: string
          occurred_at: string
          org_id: string
          outcome: Database["public"]["Enums"]["audit_outcome"]
          risk: Database["public"]["Enums"]["risk_tier"]
          subject_id: string | null
          subject_type: string | null
          tool_name: string | null
        }
        Insert: {
          action: string
          agent_name: string
          approval_id?: string | null
          detail?: Json | null
          id?: string
          occurred_at?: string
          org_id: string
          outcome: Database["public"]["Enums"]["audit_outcome"]
          risk: Database["public"]["Enums"]["risk_tier"]
          subject_id?: string | null
          subject_type?: string | null
          tool_name?: string | null
        }
        Update: {
          action?: string
          agent_name?: string
          approval_id?: string | null
          detail?: Json | null
          id?: string
          occurred_at?: string
          org_id?: string
          outcome?: Database["public"]["Enums"]["audit_outcome"]
          risk?: Database["public"]["Enums"]["risk_tier"]
          subject_id?: string | null
          subject_type?: string | null
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      consignment_movements: {
        Row: {
          account_id: string | null
          created_at: string
          direction: Database["public"]["Enums"]["consignment_direction"]
          id: string
          location_id: string | null
          location_name: string | null
          notes: string | null
          occurred_at: string
          org_id: string
          product_id: string | null
          quantity: number
          shopify_fulfillment_id: string | null
          sku: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["consignment_direction"]
          id?: string
          location_id?: string | null
          location_name?: string | null
          notes?: string | null
          occurred_at: string
          org_id: string
          product_id?: string | null
          quantity: number
          shopify_fulfillment_id?: string | null
          sku?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["consignment_direction"]
          id?: string
          location_id?: string | null
          location_name?: string | null
          notes?: string | null
          occurred_at?: string
          org_id?: string
          product_id?: string | null
          quantity?: number
          shopify_fulfillment_id?: string | null
          sku?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "consignment_movements_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consignment_movements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consignment_movements_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consignment_movements_shopify_fulfillment_id_fkey"
            columns: ["shopify_fulfillment_id"]
            isOneToOne: false
            referencedRelation: "shopify_fulfillments"
            referencedColumns: ["id"]
          },
        ]
      }
      episodic_summaries: {
        Row: {
          agent_name: string
          created_at: string
          derived_from: string[] | null
          embedding: string | null
          highlights: Json | null
          id: string
          org_id: string
          summary: string
          window_end: string
          window_start: string
        }
        Insert: {
          agent_name: string
          created_at?: string
          derived_from?: string[] | null
          embedding?: string | null
          highlights?: Json | null
          id?: string
          org_id: string
          summary: string
          window_end: string
          window_start: string
        }
        Update: {
          agent_name?: string
          created_at?: string
          derived_from?: string[] | null
          embedding?: string | null
          highlights?: Json | null
          id?: string
          org_id?: string
          summary?: string
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "episodic_summaries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      event_log: {
        Row: {
          agent_name: string | null
          appended_at: string
          id: string
          idempotency_key: string | null
          occurred_at: string
          org_id: string
          payload: Json
          seq: number
          source: string
          subject_id: string | null
          subject_type: string | null
          type: string
        }
        Insert: {
          agent_name?: string | null
          appended_at?: string
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          org_id: string
          payload: Json
          seq?: number
          source: string
          subject_id?: string | null
          subject_type?: string | null
          type: string
        }
        Update: {
          agent_name?: string | null
          appended_at?: string
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          org_id?: string
          payload?: Json
          seq?: number
          source?: string
          subject_id?: string | null
          subject_type?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      fulfillment_events: {
        Row: {
          account_id: string | null
          created_at: string
          id: string
          occurred_at: string
          org_id: string
          reason: string | null
          route: Database["public"]["Enums"]["fulfillment_route"]
          shopify_fulfillment_id: string
          shopify_order_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          id?: string
          occurred_at: string
          org_id: string
          reason?: string | null
          route: Database["public"]["Enums"]["fulfillment_route"]
          shopify_fulfillment_id: string
          shopify_order_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          id?: string
          occurred_at?: string
          org_id?: string
          reason?: string | null
          route?: Database["public"]["Enums"]["fulfillment_route"]
          shopify_fulfillment_id?: string
          shopify_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fulfillment_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_events_shopify_fulfillment_id_fkey"
            columns: ["shopify_fulfillment_id"]
            isOneToOne: false
            referencedRelation: "shopify_fulfillments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fulfillment_events_shopify_order_id_fkey"
            columns: ["shopify_order_id"]
            isOneToOne: false
            referencedRelation: "shopify_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          description: string
          id: string
          invoice_id: string
          org_id: string
          product_id: string | null
          quantity: number
          total_cents: number
          unit_price_cents: number
        }
        Insert: {
          description: string
          id?: string
          invoice_id: string
          org_id: string
          product_id?: string | null
          quantity: number
          total_cents: number
          unit_price_cents: number
        }
        Update: {
          description?: string
          id?: string
          invoice_id?: string
          org_id?: string
          product_id?: string | null
          quantity?: number
          total_cents?: number
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          account_id: string | null
          channel: Database["public"]["Enums"]["billing_channel"]
          created_at: string
          currency: string
          due_at: string | null
          fulfillment_event_id: string | null
          id: string
          invoice_number: string
          issued_at: string | null
          notes: string | null
          org_id: string
          paid_at: string | null
          state: Database["public"]["Enums"]["invoice_state"]
          stripe_invoice_id: string | null
          subtotal_cents: number
          tax_cents: number
          total_cents: number
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          channel?: Database["public"]["Enums"]["billing_channel"]
          created_at?: string
          currency: string
          due_at?: string | null
          fulfillment_event_id?: string | null
          id?: string
          invoice_number: string
          issued_at?: string | null
          notes?: string | null
          org_id: string
          paid_at?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          stripe_invoice_id?: string | null
          subtotal_cents: number
          tax_cents?: number
          total_cents: number
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          channel?: Database["public"]["Enums"]["billing_channel"]
          created_at?: string
          currency?: string
          due_at?: string | null
          fulfillment_event_id?: string | null
          id?: string
          invoice_number?: string
          issued_at?: string | null
          notes?: string | null
          org_id?: string
          paid_at?: string | null
          state?: Database["public"]["Enums"]["invoice_state"]
          stripe_invoice_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          total_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_fulfillment_event_id_fkey"
            columns: ["fulfillment_event_id"]
            isOneToOne: false
            referencedRelation: "fulfillment_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_accounts: {
        Row: {
          active: boolean
          code: string
          created_at: string
          display_name: string
          id: string
          org_id: string
          type: Database["public"]["Enums"]["ledger_account_type"]
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          display_name: string
          id?: string
          org_id: string
          type: Database["public"]["Enums"]["ledger_account_type"]
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          display_name?: string
          id?: string
          org_id?: string
          type?: Database["public"]["Enums"]["ledger_account_type"]
        }
        Relationships: [
          {
            foreignKeyName: "ledger_accounts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_lines: {
        Row: {
          amount_cents: number
          currency: string
          id: string
          ledger_account_id: string
          memo: string | null
          org_id: string
          transaction_id: string
        }
        Insert: {
          amount_cents: number
          currency: string
          id?: string
          ledger_account_id: string
          memo?: string | null
          org_id: string
          transaction_id: string
        }
        Update: {
          amount_cents?: number
          currency?: string
          id?: string
          ledger_account_id?: string
          memo?: string | null
          org_id?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_lines_ledger_account_id_fkey"
            columns: ["ledger_account_id"]
            isOneToOne: false
            referencedRelation: "ledger_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_lines_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "ledger_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_transactions: {
        Row: {
          channel: Database["public"]["Enums"]["billing_channel"]
          description: string | null
          id: string
          occurred_at: string
          org_id: string
          posted_at: string
          posted_by_agent: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref: string | null
          source_ref_type: string | null
        }
        Insert: {
          channel: Database["public"]["Enums"]["billing_channel"]
          description?: string | null
          id?: string
          occurred_at: string
          org_id: string
          posted_at?: string
          posted_by_agent?: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          source_ref_type?: string | null
        }
        Update: {
          channel?: Database["public"]["Enums"]["billing_channel"]
          description?: string | null
          id?: string
          occurred_at?: string
          org_id?: string
          posted_at?: string
          posted_by_agent?: string | null
          source?: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          source_ref_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_transactions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      observations: {
        Row: {
          agent_name: string
          confidence: number
          content: string
          embedding: string | null
          id: string
          kind: Database["public"]["Enums"]["observation_kind"]
          metadata: Json | null
          occurred_at: string
          org_id: string
          source_event_id: string | null
          subject_id: string | null
          subject_type: string | null
          superseded_by: string | null
        }
        Insert: {
          agent_name: string
          confidence?: number
          content: string
          embedding?: string | null
          id?: string
          kind: Database["public"]["Enums"]["observation_kind"]
          metadata?: Json | null
          occurred_at?: string
          org_id: string
          source_event_id?: string | null
          subject_id?: string | null
          subject_type?: string | null
          superseded_by?: string | null
        }
        Update: {
          agent_name?: string
          confidence?: number
          content?: string
          embedding?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["observation_kind"]
          metadata?: Json | null
          occurred_at?: string
          org_id?: string
          source_event_id?: string | null
          subject_id?: string | null
          subject_type?: string | null
          superseded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "event_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          base_currency: string
          created_at: string
          display_name: string
          id: string
          slug: string
        }
        Insert: {
          base_currency?: string
          created_at?: string
          display_name: string
          id?: string
          slug: string
        }
        Update: {
          base_currency?: string
          created_at?: string
          display_name?: string
          id?: string
          slug?: string
        }
        Relationships: []
      }
      outbox: {
        Row: {
          action: string
          attempts: number
          created_at: string
          id: string
          idempotency_key: string
          last_error: string | null
          next_attempt_at: string
          org_id: string
          payload: Json
          related_subject_id: string | null
          related_subject_type: string | null
          result: Json | null
          state: Database["public"]["Enums"]["outbox_state"]
          tool_name: string
          updated_at: string
        }
        Insert: {
          action: string
          attempts?: number
          created_at?: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          next_attempt_at?: string
          org_id: string
          payload: Json
          related_subject_id?: string | null
          related_subject_type?: string | null
          result?: Json | null
          state?: Database["public"]["Enums"]["outbox_state"]
          tool_name: string
          updated_at?: string
        }
        Update: {
          action?: string
          attempts?: number
          created_at?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          next_attempt_at?: string
          org_id?: string
          payload?: Json
          related_subject_id?: string | null
          related_subject_type?: string | null
          result?: Json | null
          state?: Database["public"]["Enums"]["outbox_state"]
          tool_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbox_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          id: string
          invoice_id: string
          method: string
          org_id: string
          raw: Json | null
          received_at: string
          stripe_payment_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency: string
          id?: string
          invoice_id: string
          method: string
          org_id: string
          raw?: Json | null
          received_at: string
          stripe_payment_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          method?: string
          org_id?: string
          raw?: Json | null
          received_at?: string
          stripe_payment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      price_book_entries: {
        Row: {
          created_at: string
          id: string
          org_id: string
          price_book_id: string
          product_id: string
          unit_price_cents: number
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          price_book_id: string
          product_id: string
          unit_price_cents: number
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          price_book_id?: string
          product_id?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "price_book_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_book_entries_price_book_id_fkey"
            columns: ["price_book_id"]
            isOneToOne: false
            referencedRelation: "price_books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_book_entries_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      price_books: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          id: string
          is_default: boolean
          name: string
          org_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          is_default?: boolean
          name: string
          org_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          is_default?: boolean
          name?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_books_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          id: string
          org_id: string
          shopify_product_id: string | null
          shopify_variant_id: string | null
          sku: string
          unit: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          org_id: string
          shopify_product_id?: string | null
          shopify_variant_id?: string | null
          sku: string
          unit?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          org_id?: string
          shopify_product_id?: string | null
          shopify_variant_id?: string | null
          sku?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      semantic_facts: {
        Row: {
          confidence: number
          derived_from: string[] | null
          embedding: string | null
          evidence_count: number
          first_seen_at: string
          id: string
          last_seen_at: string
          org_id: string
          predicate: string
          subject_id: string
          subject_type: string
          superseded_by: string | null
          value: Json
        }
        Insert: {
          confidence: number
          derived_from?: string[] | null
          embedding?: string | null
          evidence_count?: number
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          org_id: string
          predicate: string
          subject_id: string
          subject_type: string
          superseded_by?: string | null
          value: Json
        }
        Update: {
          confidence?: number
          derived_from?: string[] | null
          embedding?: string | null
          evidence_count?: number
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          org_id?: string
          predicate?: string
          subject_id?: string
          subject_type?: string
          superseded_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "semantic_facts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "semantic_facts_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "semantic_facts"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_customers: {
        Row: {
          account_id: string | null
          created_at_source: string | null
          default_address: Json | null
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          org_id: string
          raw: Json
          shopify_customer_id: string
          synced_at: string
          tags: string[]
          updated_at_source: string | null
        }
        Insert: {
          account_id?: string | null
          created_at_source?: string | null
          default_address?: Json | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          org_id: string
          raw: Json
          shopify_customer_id: string
          synced_at?: string
          tags?: string[]
          updated_at_source?: string | null
        }
        Update: {
          account_id?: string | null
          created_at_source?: string | null
          default_address?: Json | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          org_id?: string
          raw?: Json
          shopify_customer_id?: string
          synced_at?: string
          tags?: string[]
          updated_at_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopify_customers_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopify_customers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_fulfillments: {
        Row: {
          id: string
          location_id: string | null
          location_name: string | null
          occurred_at: string
          org_id: string
          raw: Json
          shopify_fulfillment_id: string
          shopify_order_id: string
          status: string
          synced_at: string
          tracking_company: string | null
          tracking_numbers: string[]
        }
        Insert: {
          id?: string
          location_id?: string | null
          location_name?: string | null
          occurred_at: string
          org_id: string
          raw: Json
          shopify_fulfillment_id: string
          shopify_order_id: string
          status: string
          synced_at?: string
          tracking_company?: string | null
          tracking_numbers?: string[]
        }
        Update: {
          id?: string
          location_id?: string | null
          location_name?: string | null
          occurred_at?: string
          org_id?: string
          raw?: Json
          shopify_fulfillment_id?: string
          shopify_order_id?: string
          status?: string
          synced_at?: string
          tracking_company?: string | null
          tracking_numbers?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "shopify_fulfillments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopify_fulfillments_shopify_order_id_fkey"
            columns: ["shopify_order_id"]
            isOneToOne: false
            referencedRelation: "shopify_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_order_lines: {
        Row: {
          id: string
          org_id: string
          quantity: number
          raw: Json
          shopify_line_id: string
          shopify_order_id: string
          shopify_variant_id: string | null
          sku: string | null
          title: string | null
          total_cents: number
          unit_price_cents: number
        }
        Insert: {
          id?: string
          org_id: string
          quantity: number
          raw: Json
          shopify_line_id: string
          shopify_order_id: string
          shopify_variant_id?: string | null
          sku?: string | null
          title?: string | null
          total_cents: number
          unit_price_cents: number
        }
        Update: {
          id?: string
          org_id?: string
          quantity?: number
          raw?: Json
          shopify_line_id?: string
          shopify_order_id?: string
          shopify_variant_id?: string | null
          sku?: string | null
          title?: string | null
          total_cents?: number
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "shopify_order_lines_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopify_order_lines_shopify_order_id_fkey"
            columns: ["shopify_order_id"]
            isOneToOne: false
            referencedRelation: "shopify_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_orders: {
        Row: {
          currency: string
          financial_status: string | null
          fulfillment_status: string | null
          id: string
          org_id: string
          placed_at: string | null
          raw: Json
          shopify_customer_id: string | null
          shopify_order_id: string
          shopify_order_name: string | null
          subtotal_cents: number
          synced_at: string
          tags: string[]
          total_cents: number
          total_tax_cents: number
          updated_at_source: string | null
        }
        Insert: {
          currency: string
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          org_id: string
          placed_at?: string | null
          raw: Json
          shopify_customer_id?: string | null
          shopify_order_id: string
          shopify_order_name?: string | null
          subtotal_cents: number
          synced_at?: string
          tags?: string[]
          total_cents: number
          total_tax_cents?: number
          updated_at_source?: string | null
        }
        Update: {
          currency?: string
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          org_id?: string
          placed_at?: string | null
          raw?: Json
          shopify_customer_id?: string | null
          shopify_order_id?: string
          shopify_order_name?: string | null
          subtotal_cents?: number
          synced_at?: string
          tags?: string[]
          total_cents?: number
          total_tax_cents?: number
          updated_at_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopify_orders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_agent: string | null
          created_at: string
          detail: Json | null
          due_at: string | null
          id: string
          org_id: string
          priority: number
          state: Database["public"]["Enums"]["task_state"]
          subject_id: string | null
          subject_type: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_agent?: string | null
          created_at?: string
          detail?: Json | null
          due_at?: string | null
          id?: string
          org_id: string
          priority?: number
          state?: Database["public"]["Enums"]["task_state"]
          subject_id?: string | null
          subject_type?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_agent?: string | null
          created_at?: string
          detail?: Json | null
          due_at?: string | null
          id?: string
          org_id?: string
          priority?: number
          state?: Database["public"]["Enums"]["task_state"]
          subject_id?: string | null
          subject_type?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_grants: {
        Row: {
          agent_name: string
          enabled: boolean
          granted_at: string
          id: string
          org_id: string
          risk: Database["public"]["Enums"]["risk_tier"]
          tool_name: string
        }
        Insert: {
          agent_name: string
          enabled?: boolean
          granted_at?: string
          id?: string
          org_id: string
          risk: Database["public"]["Enums"]["risk_tier"]
          tool_name: string
        }
        Update: {
          agent_name?: string
          enabled?: boolean
          granted_at?: string
          id?: string
          org_id?: string
          risk?: Database["public"]["Enums"]["risk_tier"]
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      seed_chart_of_accounts: { Args: { p_org_id: string }; Returns: undefined }
    }
    Enums: {
      agent_kind: "worker" | "analytical" | "orchestrator"
      approval_state: "pending" | "approved" | "rejected" | "expired"
      audit_outcome: "success" | "failure" | "blocked"
      billing_channel: "wholesale" | "consignment" | "dtc" | "internal"
      consignment_direction: "out" | "return" | "sold"
      fulfillment_route: "wholesale" | "consignment" | "ignored"
      invoice_state:
        | "draft"
        | "pending_approval"
        | "issued"
        | "paid"
        | "partial"
        | "overdue"
        | "void"
      ledger_account_type:
        | "asset"
        | "liability"
        | "equity"
        | "revenue"
        | "expense"
      ledger_source:
        | "invoice_issued"
        | "invoice_voided"
        | "payment_received"
        | "payment_refunded"
        | "payout_received"
        | "manual_adjustment"
      observation_kind: "fact" | "preference" | "pattern" | "anomaly" | "note"
      outbox_state: "pending" | "in_flight" | "sent" | "failed" | "dead"
      risk_tier: "auto" | "notify" | "approve_required"
      task_state: "open" | "in_progress" | "blocked" | "done" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      agent_kind: ["worker", "analytical", "orchestrator"],
      approval_state: ["pending", "approved", "rejected", "expired"],
      audit_outcome: ["success", "failure", "blocked"],
      billing_channel: ["wholesale", "consignment", "dtc", "internal"],
      consignment_direction: ["out", "return", "sold"],
      fulfillment_route: ["wholesale", "consignment", "ignored"],
      invoice_state: [
        "draft",
        "pending_approval",
        "issued",
        "paid",
        "partial",
        "overdue",
        "void",
      ],
      ledger_account_type: [
        "asset",
        "liability",
        "equity",
        "revenue",
        "expense",
      ],
      ledger_source: [
        "invoice_issued",
        "invoice_voided",
        "payment_received",
        "payment_refunded",
        "payout_received",
        "manual_adjustment",
      ],
      observation_kind: ["fact", "preference", "pattern", "anomaly", "note"],
      outbox_state: ["pending", "in_flight", "sent", "failed", "dead"],
      risk_tier: ["auto", "notify", "approve_required"],
      task_state: ["open", "in_progress", "blocked", "done", "cancelled"],
    },
  },
} as const
