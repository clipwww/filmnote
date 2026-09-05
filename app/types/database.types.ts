// 由 `npm run db:types` 從資料庫目錄產生。請勿手動編輯。
// 產生器：scripts/gen-types.ts（不需要 Docker，見該檔說明）

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      certificate: {
        Row: {
          id: string
          film_id: string | null
          permit_no: string
          roc_year: number
          gregorian_year: number
          rating: string | null
          title_zh: string
          title_original: string
          country: string | null
          language: string | null
          producer: string | null
          runtime_minutes: number | null
          version_note: string | null
          defects: string[]
          raw: Json | null
          import_run_id: number | null
          created_at: string
        }
        Insert: {
          id: string
          film_id?: string | null
          permit_no: string
          roc_year: number
          gregorian_year: number
          rating?: string | null
          title_zh?: string
          title_original?: string
          country?: string | null
          language?: string | null
          producer?: string | null
          runtime_minutes?: number | null
          version_note?: string | null
          defects?: string[]
          raw?: Json | null
          import_run_id?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          film_id?: string | null
          permit_no?: string
          roc_year?: number
          gregorian_year?: number
          rating?: string | null
          title_zh?: string
          title_original?: string
          country?: string | null
          language?: string | null
          producer?: string | null
          runtime_minutes?: number | null
          version_note?: string | null
          defects?: string[]
          raw?: Json | null
          import_run_id?: number | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "certificate_film_id_fkey"
            columns: ["film_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "certificate_import_run_id_fkey"
            columns: ["import_run_id"]
            isOneToOne: false
            referencedRelation: "import_run"
            referencedColumns: ["id"]
          },
        ]
      }
      copyright_strike: {
        Row: {
          id: number
          profile_id: string
          notice_id: number | null
          created_at: string
          revoked_at: string | null
          note: string | null
        }
        Insert: {
          id?: number
          profile_id: string
          notice_id?: number | null
          created_at?: string
          revoked_at?: string | null
          note?: string | null
        }
        Update: {
          id?: number
          profile_id?: string
          notice_id?: number | null
          created_at?: string
          revoked_at?: string | null
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "copyright_strike_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "takedown_notice"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "copyright_strike_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      counter_notice: {
        Row: {
          id: number
          notice_id: number
          profile_id: string
          reason: string
          received_at: string
          forwarded_at: string | null
          litigation_deadline_at: string | null
          restore_deadline_at: string | null
          restored_at: string | null
        }
        Insert: {
          id?: number
          notice_id: number
          profile_id: string
          reason: string
          received_at?: string
          forwarded_at?: string | null
          litigation_deadline_at?: string | null
          restore_deadline_at?: string | null
          restored_at?: string | null
        }
        Update: {
          id?: number
          notice_id?: number
          profile_id?: string
          reason?: string
          received_at?: string
          forwarded_at?: string | null
          litigation_deadline_at?: string | null
          restore_deadline_at?: string | null
          restored_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "counter_notice_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "takedown_notice"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "counter_notice_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      data_report: {
        Row: {
          id: number
          reporter_id: string | null
          subject_kind: string
          subject_key: string
          body: string
          status: string
          created_at: string
        }
        Insert: {
          id?: number
          reporter_id?: string | null
          subject_kind: string
          subject_key: string
          body: string
          status?: string
          created_at?: string
        }
        Update: {
          id?: number
          reporter_id?: string | null
          subject_kind?: string
          subject_key?: string
          body?: string
          status?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_report_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      film: {
        Row: {
          id: string
          tmdb_id: number | null
          imdb_id: string | null
          title_zh: string
          title_zh_source: Database["public"]["Enums"]["source_authority"]
          title_original: string
          title_original_source: Database["public"]["Enums"]["source_authority"]
          country: string
          language: string | null
          runtime_minutes: number | null
          release_year: number | null
          first_seen_roc_year: number | null
          origin: Database["public"]["Enums"]["film_origin"]
          visibility: Database["public"]["Enums"]["visibility"]
          review_state: Database["public"]["Enums"]["review_state"]
          moderation_state: Database["public"]["Enums"]["moderation_state"]
          created_by: string | null
          ugc_poster_path: string | null
          slug: string | null
          merged_into_film_id: string | null
          merged_at: string | null
          search_text: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          tmdb_id?: number | null
          imdb_id?: string | null
          title_zh?: string
          title_zh_source?: Database["public"]["Enums"]["source_authority"]
          title_original?: string
          title_original_source?: Database["public"]["Enums"]["source_authority"]
          country?: string
          language?: string | null
          runtime_minutes?: number | null
          release_year?: number | null
          first_seen_roc_year?: number | null
          origin?: Database["public"]["Enums"]["film_origin"]
          visibility?: Database["public"]["Enums"]["visibility"]
          review_state?: Database["public"]["Enums"]["review_state"]
          moderation_state?: Database["public"]["Enums"]["moderation_state"]
          created_by?: string | null
          ugc_poster_path?: string | null
          slug?: string | null
          merged_into_film_id?: string | null
          merged_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          tmdb_id?: number | null
          imdb_id?: string | null
          title_zh?: string
          title_zh_source?: Database["public"]["Enums"]["source_authority"]
          title_original?: string
          title_original_source?: Database["public"]["Enums"]["source_authority"]
          country?: string
          language?: string | null
          runtime_minutes?: number | null
          release_year?: number | null
          first_seen_roc_year?: number | null
          origin?: Database["public"]["Enums"]["film_origin"]
          visibility?: Database["public"]["Enums"]["visibility"]
          review_state?: Database["public"]["Enums"]["review_state"]
          moderation_state?: Database["public"]["Enums"]["moderation_state"]
          created_by?: string | null
          ugc_poster_path?: string | null
          slug?: string | null
          merged_into_film_id?: string | null
          merged_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "film_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "film_merged_into_film_id_fkey"
            columns: ["merged_into_film_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
        ]
      }
      film_identity: {
        Row: {
          key: string
          kind: Database["public"]["Enums"]["identity_kind"]
          film_id: string
          is_primary: boolean
          assigned_at: string
          note: string | null
        }
        Insert: {
          key: string
          kind: Database["public"]["Enums"]["identity_kind"]
          film_id: string
          is_primary?: boolean
          assigned_at?: string
          note?: string | null
        }
        Update: {
          key?: string
          kind?: Database["public"]["Enums"]["identity_kind"]
          film_id?: string
          is_primary?: boolean
          assigned_at?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "film_identity_film_id_fkey"
            columns: ["film_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
        ]
      }
      film_merge_log: {
        Row: {
          id: number
          loser_id: string
          winner_id: string
          performed_by: string | null
          reason: string | null
          moved_records: number
          snapshot: Json | null
          created_at: string
        }
        Insert: {
          id?: number
          loser_id: string
          winner_id: string
          performed_by?: string | null
          reason?: string | null
          moved_records?: number
          snapshot?: Json | null
          created_at?: string
        }
        Update: {
          id?: number
          loser_id?: string
          winner_id?: string
          performed_by?: string | null
          reason?: string | null
          moved_records?: number
          snapshot?: Json | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "film_merge_log_loser_id_fkey"
            columns: ["loser_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "film_merge_log_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "film_merge_log_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
        ]
      }
      film_tmdb_snapshot: {
        Row: {
          film_id: string
          tmdb_id: number
          state: Database["public"]["Enums"]["tmdb_cache_state"]
          title_zh: string | null
          title_original: string | null
          overview: string | null
          poster_path: string | null
          backdrop_path: string | null
          runtime_minutes: number | null
          release_date: string | null
          tw_release_date: string | null
          genre_ids: number[] | null
          payload: Json | null
          fetched_at: string | null
          expires_at: string
          next_refresh_at: string
          attempts: number
          last_error: string | null
          etag: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          film_id: string
          tmdb_id: number
          state?: Database["public"]["Enums"]["tmdb_cache_state"]
          title_zh?: string | null
          title_original?: string | null
          overview?: string | null
          poster_path?: string | null
          backdrop_path?: string | null
          runtime_minutes?: number | null
          release_date?: string | null
          tw_release_date?: string | null
          genre_ids?: number[] | null
          payload?: Json | null
          fetched_at?: string | null
          expires_at?: string
          next_refresh_at?: string
          attempts?: number
          last_error?: string | null
          etag?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          film_id?: string
          tmdb_id?: number
          state?: Database["public"]["Enums"]["tmdb_cache_state"]
          title_zh?: string | null
          title_original?: string | null
          overview?: string | null
          poster_path?: string | null
          backdrop_path?: string | null
          runtime_minutes?: number | null
          release_date?: string | null
          tw_release_date?: string | null
          genre_ids?: number[] | null
          payload?: Json | null
          fetched_at?: string | null
          expires_at?: string
          next_refresh_at?: string
          attempts?: number
          last_error?: string | null
          etag?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "film_tmdb_snapshot_film_id_fkey"
            columns: ["film_id"]
            isOneToOne: true
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
        ]
      }
      import_run: {
        Row: {
          id: number
          kind: string
          status: string
          source_url: string | null
          roc_year: number | null
          note: string | null
          stats: Json | null
          started_at: string
          finished_at: string | null
        }
        Insert: {
          id?: number
          kind: string
          status?: string
          source_url?: string | null
          roc_year?: number | null
          note?: string | null
          stats?: Json | null
          started_at?: string
          finished_at?: string | null
        }
        Update: {
          id?: number
          kind?: string
          status?: string
          source_url?: string | null
          roc_year?: number | null
          note?: string | null
          stats?: Json | null
          started_at?: string
          finished_at?: string | null
        }
        Relationships: []
      }
      legal_acceptance: {
        Row: {
          profile_id: string
          document_id: number
          accepted_at: string
        }
        Insert: {
          profile_id: string
          document_id: number
          accepted_at?: string
        }
        Update: {
          profile_id?: string
          document_id?: number
          accepted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_acceptance_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "legal_document"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_acceptance_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_document: {
        Row: {
          id: number
          kind: Database["public"]["Enums"]["legal_doc_kind"]
          version: string
          effective_at: string
          body_md: string
        }
        Insert: {
          id?: number
          kind: Database["public"]["Enums"]["legal_doc_kind"]
          version: string
          effective_at?: string
          body_md: string
        }
        Update: {
          id?: number
          kind?: Database["public"]["Enums"]["legal_doc_kind"]
          version?: string
          effective_at?: string
          body_md?: string
        }
        Relationships: []
      }
      profile: {
        Row: {
          id: string
          username: string
          display_name: string | null
          avatar_url: string | null
          bio: string | null
          show_cost: boolean
          timezone: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          username: string
          display_name?: string | null
          avatar_url?: string | null
          bio?: string | null
          show_cost?: boolean
          timezone?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          username?: string
          display_name?: string | null
          avatar_url?: string | null
          bio?: string | null
          show_cost?: boolean
          timezone?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_private: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["account_role"]
          service_status: Database["public"]["Enums"]["service_status"]
          strike_count: number
          suspended_at: string | null
          deletion_requested_at: string | null
          updated_at: string
        }
        Insert: {
          id: string
          role?: Database["public"]["Enums"]["account_role"]
          service_status?: Database["public"]["Enums"]["service_status"]
          strike_count?: number
          suspended_at?: string | null
          deletion_requested_at?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["account_role"]
          service_status?: Database["public"]["Enums"]["service_status"]
          strike_count?: number
          suspended_at?: string | null
          deletion_requested_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_private_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      screening_format: {
        Row: {
          code: string
          label: string
          sort_order: number
          active: boolean
        }
        Insert: {
          code: string
          label: string
          sort_order?: number
          active?: boolean
        }
        Update: {
          code?: string
          label?: string
          sort_order?: number
          active?: boolean
        }
        Relationships: []
      }
      takedown_notice: {
        Row: {
          id: number
          status: Database["public"]["Enums"]["notice_status"]
          claimant_name: string
          claimant_email: string
          claimant_phone: string | null
          work_description: string
          target_url: string
          target_film_id: string | null
          target_record_id: string | null
          statement_good_faith: boolean
          received_at: string
          actioned_at: string | null
          handled_by: string | null
          note: string | null
        }
        Insert: {
          id?: number
          status?: Database["public"]["Enums"]["notice_status"]
          claimant_name: string
          claimant_email: string
          claimant_phone?: string | null
          work_description: string
          target_url: string
          target_film_id?: string | null
          target_record_id?: string | null
          statement_good_faith?: boolean
          received_at?: string
          actioned_at?: string | null
          handled_by?: string | null
          note?: string | null
        }
        Update: {
          id?: number
          status?: Database["public"]["Enums"]["notice_status"]
          claimant_name?: string
          claimant_email?: string
          claimant_phone?: string | null
          work_description?: string
          target_url?: string
          target_film_id?: string | null
          target_record_id?: string | null
          statement_good_faith?: boolean
          received_at?: string
          actioned_at?: string | null
          handled_by?: string | null
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "takedown_notice_handled_by_fkey"
            columns: ["handled_by"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "takedown_notice_target_film_id_fkey"
            columns: ["target_film_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "takedown_notice_target_record_id_fkey"
            columns: ["target_record_id"]
            isOneToOne: false
            referencedRelation: "viewing_record"
            referencedColumns: ["id"]
          },
        ]
      }
      username: {
        Row: {
          name: string
          profile_id: string | null
          kind: string
          assigned_at: string
          released_at: string | null
        }
        Insert: {
          name: string
          profile_id?: string | null
          kind: string
          assigned_at?: string
          released_at?: string | null
        }
        Update: {
          name?: string
          profile_id?: string | null
          kind?: string
          assigned_at?: string
          released_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "username_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
        ]
      }
      venue: {
        Row: {
          id: string
          kind: Database["public"]["Enums"]["venue_kind"]
          name: string
          company_name: string
          hall_count: number
          address: string
          phone: string
          city: string
          lat: number | null
          lng: number | null
          status: Database["public"]["Enums"]["venue_status"]
          merged_into_venue_id: string | null
          closed_at: string | null
          sort_weight: number
          raw: Json | null
          last_import_id: number | null
          last_seen_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          kind: Database["public"]["Enums"]["venue_kind"]
          name: string
          company_name?: string
          hall_count?: number
          address?: string
          phone?: string
          city?: string
          lat?: number | null
          lng?: number | null
          status?: Database["public"]["Enums"]["venue_status"]
          merged_into_venue_id?: string | null
          closed_at?: string | null
          sort_weight?: number
          raw?: Json | null
          last_import_id?: number | null
          last_seen_at?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          kind?: Database["public"]["Enums"]["venue_kind"]
          name?: string
          company_name?: string
          hall_count?: number
          address?: string
          phone?: string
          city?: string
          lat?: number | null
          lng?: number | null
          status?: Database["public"]["Enums"]["venue_status"]
          merged_into_venue_id?: string | null
          closed_at?: string | null
          sort_weight?: number
          raw?: Json | null
          last_import_id?: number | null
          last_seen_at?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_last_import_id_fkey"
            columns: ["last_import_id"]
            isOneToOne: false
            referencedRelation: "import_run"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_merged_into_venue_id_fkey"
            columns: ["merged_into_venue_id"]
            isOneToOne: false
            referencedRelation: "venue"
            referencedColumns: ["id"]
          },
        ]
      }
      viewing_record: {
        Row: {
          id: string
          user_id: string
          film_id: string
          venue_id: string
          watched_on: string
          watched_time: string | null
          tz: string
          ticket_count: number | null
          hall_label: string | null
          format_code: string | null
          format_note: string | null
          memo: string | null
          visibility: Database["public"]["Enums"]["visibility"]
          moderation_state: Database["public"]["Enums"]["moderation_state"]
          import_key: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          film_id: string
          venue_id: string
          watched_on: string
          watched_time?: string | null
          tz?: string
          ticket_count?: number | null
          hall_label?: string | null
          format_code?: string | null
          format_note?: string | null
          memo?: string | null
          visibility?: Database["public"]["Enums"]["visibility"]
          moderation_state?: Database["public"]["Enums"]["moderation_state"]
          import_key?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          film_id?: string
          venue_id?: string
          watched_on?: string
          watched_time?: string | null
          tz?: string
          ticket_count?: number | null
          hall_label?: string | null
          format_code?: string | null
          format_note?: string | null
          memo?: string | null
          visibility?: Database["public"]["Enums"]["visibility"]
          moderation_state?: Database["public"]["Enums"]["moderation_state"]
          import_key?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "viewing_record_film_id_fkey"
            columns: ["film_id"]
            isOneToOne: false
            referencedRelation: "film"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewing_record_format_code_fkey"
            columns: ["format_code"]
            isOneToOne: false
            referencedRelation: "screening_format"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "viewing_record_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewing_record_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venue"
            referencedColumns: ["id"]
          },
        ]
      }
      viewing_record_cost: {
        Row: {
          record_id: string
          amount: number
          currency: string
          created_at: string
          updated_at: string
        }
        Insert: {
          record_id: string
          amount: number
          currency?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          record_id?: string
          amount?: number
          currency?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "viewing_record_cost_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: true
            referencedRelation: "viewing_record"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      film_public: {
        Row: {
          id: string | null
          slug: string | null
          tmdb_id: number | null
          imdb_id: string | null
          title_zh: string | null
          title_original: string | null
          country: string | null
          language: string | null
          runtime_minutes: number | null
          release_year: number | null
          first_seen_roc_year: number | null
          origin: Database["public"]["Enums"]["film_origin"] | null
          ugc_poster_path: string | null
          tmdb_poster_path: string | null
          tmdb_backdrop_path: string | null
          overview: string | null
          tw_release_date: string | null
          updated_at: string | null
          search_text: string | null
        }
        Relationships: []
      }
      tmdb_refresh_due: {
        Row: {
          film_id: string | null
          tmdb_id: number | null
          etag: string | null
          attempts: number | null
          expires_at: string | null
          next_refresh_at: string | null
        }
        Relationships: []
      }
      viewing_record_public: {
        Row: {
          id: string | null
          user_id: string | null
          username: string | null
          film_id: string | null
          venue_id: string | null
          watched_on: string | null
          watched_time: string | null
          tz: string | null
          ticket_count: number | null
          hall_label: string | null
          format_code: string | null
          format_note: string | null
          memo: string | null
          cost_amount: number | null
          cost_currency: string | null
          created_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      account_is_servable: {
        Args: {
          uid: string
        }
        Returns: boolean
      }
      apply_tmdb_snapshot: {
        Args: {
          p_film_id: string
        }
        Returns: undefined
      }
      approve_film: {
        Args: {
          p_film: string
          p_approve: boolean
        }
        Returns: undefined
      }
      business_days_after: {
        Args: {
          start_ts: string
          n: number
        }
        Returns: string
      }
      export_my_data: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      film_usable_by: {
        Args: {
          p_film: string
          p_user: string
        }
        Returns: boolean
      }
      is_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_service_context: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_staff: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      link_film_to_tmdb: {
        Args: {
          p_film: string
          p_tmdb: number
        }
        Returns: string
      }
      merge_films: {
        Args: {
          p_loser: string
          p_winner: string
          p_reason: string
        }
        Returns: undefined
      }
      owner_shows_cost: {
        Args: {
          uid: string
        }
        Returns: boolean
      }
      purge_expired_tmdb_cache: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      record_is_public: {
        Args: {
          p_record: string
        }
        Returns: boolean
      }
      record_owner: {
        Args: {
          p_record: string
        }
        Returns: string
      }
      rename_username: {
        Args: {
          p_new: string
        }
        Returns: string
      }
      resolve_film: {
        Args: {
          p_key: string
        }
        Returns: string
      }
      resolve_username: {
        Args: {
          p_name: string
        }
        Returns: string
      }
      seed_films: {
        Args: {
          p_films: Json
        }
        Returns: number
      }
      slugify: {
        Args: {
          src: string
        }
        Returns: string
      }
      ugc_poster_film: {
        Args: {
          p_name: string
        }
        Returns: string
      }
    }
    Enums: {
      account_role: "user" | "moderator" | "admin"
      film_origin: "gov" | "tmdb" | "ugc"
      identity_kind: "tmdb" | "gov" | "ugc" | "imdb" | "slug" | "legacy"
      legal_doc_kind: "terms" | "privacy" | "copyright_policy"
      moderation_state: "visible" | "withheld" | "removed"
      notice_status: "received" | "rejected" | "actioned" | "counter_received" | "counter_forwarded" | "restored" | "litigation_notified"
      review_state: "pending" | "approved" | "rejected"
      service_status: "active" | "limited" | "terminated"
      source_authority: "gov" | "tmdb" | "ugc" | "admin"
      tmdb_cache_state: "pending" | "fresh" | "failed" | "gone"
      venue_kind: "cinema" | "streaming" | "festival" | "home" | "other"
      venue_status: "active" | "closed" | "merged"
      visibility: "public" | "private"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
