# Use the official Ruby image
FROM ruby:3.4.1-bullseye

# Set environment variables
ENV RAILS_ENV=production \
    BUNDLE_WITHOUT="development:test" \
    BUNDLE_PATH="/usr/local/bundle" \
    BUNDLE_DEPLOYMENT="0" \
    PORT=3000 \
    SECRET_KEY_BASE_DUMMY=1 \
    RAILS_SERVE_STATIC_FILES=true \
    RAILS_LOG_TO_STDOUT=true

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
    build-essential \
    nodejs \
    tzdata \
    libyaml-dev \
    git \
    pkg-config \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Install bundler (match version in Gemfile.lock)
RUN gem install bundler

# Copy Gemfile and Gemfile.lock
COPY Gemfile Gemfile.lock ./

# Install dependencies
RUN bundle install

# Copy the rest of the application code
COPY . .

# Fix permissions and line endings
RUN chmod +x bin/* && \
    sed -i 's/\r$//' bin/*

# Precompile assets
RUN bundle exec rails assets:precompile

# Expose the port
EXPOSE 3000

# Start the server
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
