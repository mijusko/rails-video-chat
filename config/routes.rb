Rails.application.routes.draw do
  root "landing#index"

  post "sessions" => "sessions#create"
  delete "sessions" => "sessions#destroy"

  get "rooms"       => "rooms#index",  as: :rooms
  get "rooms/:id"   => "rooms#show",   as: :room

  get "up" => "rails/health#show", as: :rails_health_check
end
